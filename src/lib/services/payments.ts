import { randomBytes } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { centsToTelebirrAmount } from "@/lib/money";
import { TelebirrClient, TelebirrApiError } from "@/lib/telebirr/client";
import { missingTelebirrVariables, readTelebirrConfig } from "@/lib/telebirr/config";
import { emitAlert } from "@/lib/alerts/queue";
import {
  orphanPaymentAlert,
  paymentSettledAlert,
  seatFromBalanceAlert,
  walletTopupAlert,
} from "@/lib/alerts/templates";
import { notifyPaymentSettled, notifyTopup } from "@/lib/notices/participants";
import { runDrawIfComplete } from "./draws";
import { alertDrawSettled, isDrawSettled } from "./sweep";
import {
  applyDebit,
  balanceOf,
  credit,
  TOPUP_MAX_CENTS,
  TOPUP_MIN_CENTS,
  WalletError,
  walletOfAccount,
} from "./wallet";

export type PaymentMode = "telebirr" | "simulate";

export type ModeResolution = { mode: PaymentMode; client: TelebirrClient | null } | { error: string };

export function gatewayStatus() {
  const config = readTelebirrConfig();
  return {
    configured: Boolean(config),
    missingVariables: missingTelebirrVariables(),
    environment: config?.environment ?? null,
    notifyIsPublic: config ? config.notifyUrl.startsWith("https://") : false,
  };
}

/**
 * Simulated settlement is a development convenience only. Production refuses to
 * run without real merchant credentials so a fake receipt can never mark a
 * number as paid.
 */
export function resolveMode(): ModeResolution {
  const requested = (process.env.PAYMENT_MODE ?? "simulate").trim().toLowerCase();
  const config = readTelebirrConfig();

  if (requested === "telebirr") {
    if (!config) {
      return {
        error:
          "PAYMENT_MODE=telebirr but the merchant credentials are incomplete: " +
          missingTelebirrVariables().join(", "),
      };
    }
    return { mode: "telebirr", client: new TelebirrClient(config) };
  }

  if (process.env.NODE_ENV === "production") {
    if (!config) {
      return {
        error:
          "Production needs PAYMENT_MODE=telebirr with credentials; missing " +
          missingTelebirrVariables().join(", "),
      };
    }
    return { mode: "telebirr", client: new TelebirrClient(config) };
  }

  return { mode: "simulate", client: config ? new TelebirrClient(config) : null };
}

/** Telebirr accepts ^[A-Za-z0-9]+$ and echoes this id back on every leg. */
export function newMerchOrderId(): string {
  return `LK${Date.now()}${randomBytes(3).toString("hex").toUpperCase()}`;
}

export type Checkout = {
  merchOrderId: string;
  mode: PaymentMode;
  /** absolute for telebirr, in-app route for simulate */
  checkoutUrl: string;
};

export async function startPayment(input: { entryId: string; accountId: string }): Promise<Checkout> {
  const resolution = resolveMode();
  if ("error" in resolution) throw new TelebirrApiError(resolution.error);
  const { mode, client } = resolution;

  const entry = await prisma.entry.findFirst({
    where: { id: input.entryId, accountId: input.accountId, status: "pending_payment" },
    include: { house: { select: { label: true } }, payments: true },
  });
  if (!entry) throw new TelebirrApiError("entry_not_found_or_not_payable");

  const open = entry.payments.find((payment) =>
    ["created", "checkout_published"].includes(payment.status),
  );
  if (open && mode === "simulate") {
    return { merchOrderId: open.merchOrderId, mode, checkoutUrl: `/pay/${open.merchOrderId}` };
  }
  if (open && open.prepayId && client) {
    // re-offer the checkout link for the same merchant order id
    return { merchOrderId: open.merchOrderId, mode, checkoutUrl: client.buildCheckoutUrl(open.prepayId) };
  }

  const merchOrderId = newMerchOrderId();
  const payment = await prisma.payment.create({
    data: {
      entryId: entry.id,
      merchOrderId,
      amountCents: entry.amountCents,
      feeCents: entry.feeCents,
      currency: "ETB",
      status: "created",
    },
  });

  if (mode === "simulate") {
    return { merchOrderId, mode, checkoutUrl: `/pay/${merchOrderId}` };
  }
  if (!client) throw new TelebirrApiError("telebirr client unavailable");

  const order = await client.createOrder({
    // ASCII only: gateway order titles are logged and echoed back verbatim
    title: `Lucky house ${entry.house.label} number ${entry.seatNumber}`,
    // the entry total already carries the service charge; settlePayment compares
    // the gateway amount against this same figure
    amount: centsToTelebirrAmount(entry.amountCents),
    merchOrderId,
  });
  const checkoutUrl = client.buildCheckoutUrl(order.prepayId);

  await prisma.payment.update({
    where: { id: payment.id },
    data: { prepayId: order.prepayId, status: "checkout_published" },
  });

  return { merchOrderId, mode, checkoutUrl };
}

/**
 * Balance top-up: the same gateway legs a seat payment uses, but the money lands
 * in the wallet ledger instead of buying a number, so it carries no fee.
 */
export async function startTopup(input: { accountId: string; amountCents: number }): Promise<Checkout> {
  if (!Number.isInteger(input.amountCents)) throw new TelebirrApiError("amount_must_be_whole_cents");
  if (input.amountCents < TOPUP_MIN_CENTS || input.amountCents > TOPUP_MAX_CENTS) {
    throw new TelebirrApiError(
      `amount_out_of_range: between ${TOPUP_MIN_CENTS / 100} and ${TOPUP_MAX_CENTS / 100} birr`,
    );
  }

  const resolution = resolveMode();
  if ("error" in resolution) throw new TelebirrApiError(resolution.error);
  const { mode, client } = resolution;

  const wallet = await walletOfAccount(input.accountId);
  const openWhere = {
    walletId: wallet.id,
    purpose: "topup",
    status: { in: ["created", "checkout_published"] },
  };

  // an unpaid order for the same amount is the same intention: a second tap
  // re-offers its checkout link rather than opening another one at the gateway
  const open = await prisma.payment.findFirst({
    where: { ...openWhere, amountCents: input.amountCents },
    orderBy: { createdAt: "desc" },
  });
  if (open && mode === "simulate") {
    return { merchOrderId: open.merchOrderId, mode, checkoutUrl: `/pay/${open.merchOrderId}` };
  }
  if (open?.prepayId && client) {
    return { merchOrderId: open.merchOrderId, mode, checkoutUrl: client.buildCheckoutUrl(open.prepayId) };
  }

  // an order the gateway never accepted cannot be paid, so it is closed out
  // before a new one takes its place
  await prisma.payment.updateMany({ where: openWhere, data: { status: "cancelled" } });

  const merchOrderId = newMerchOrderId();
  const payment = await prisma.payment.create({
    data: {
      merchOrderId,
      walletId: wallet.id,
      purpose: "topup",
      amountCents: input.amountCents,
      feeCents: 0,
      currency: "ETB",
      status: "created",
    },
  });

  if (mode === "simulate") {
    return { merchOrderId, mode, checkoutUrl: `/pay/${merchOrderId}` };
  }
  if (!client) throw new TelebirrApiError("telebirr client unavailable");

  const order = await client.createOrder({
    // ASCII only, and no phone number: the title is stored on the gateway side
    title: `Lucky wallet top-up ${centsToTelebirrAmount(input.amountCents)} ETB`,
    amount: centsToTelebirrAmount(input.amountCents),
    merchOrderId,
  });

  await prisma.payment.update({
    where: { id: payment.id },
    data: { prepayId: order.prepayId, status: "checkout_published" },
  });

  return { merchOrderId, mode, checkoutUrl: client.buildCheckoutUrl(order.prepayId) };
}

/**
 * Buying a number with balance instead of opening another gateway order. The
 * claim, the receipt and the ledger movement commit as one transaction, so a
 * number can never end up paid by money the wallet does not hold — and a second
 * tap finds the entry already paid rather than spending it twice.
 */
export async function paySeatFromBalance(input: {
  entryId: string;
  accountId: string;
}): Promise<BalancePayResult> {
  const entry = await prisma.entry.findFirst({
    where: { id: input.entryId, accountId: input.accountId, status: "pending_payment" },
    select: {
      id: true,
      houseId: true,
      house: { select: { label: true } },
      round: true,
      seatNumber: true,
      amountCents: true,
      feeCents: true,
      accountId: true,
    },
  });
  if (!entry) return { settled: false, reason: "not_found" };

  const wallet = await walletOfAccount(input.accountId);
  const short = (balanceCents: number) => ({
    settled: false as const,
    reason: "insufficient_balance" as const,
    balanceCents,
    requiredCents: entry.amountCents,
  });

  const merchOrderId = newMerchOrderId();
  const paidAt = new Date();

  let spent: { balance: number } | "claimed_elsewhere" | "short";
  try {
    spent = await prisma.$transaction(async (tx) => {
      if (!(await claimEntry(tx, entry.id, paidAt))) return "claimed_elsewhere";
      await tx.payment.create({
        data: {
          entryId: entry.id,
          walletId: wallet.id,
          merchOrderId,
          purpose: "seat",
          amountCents: entry.amountCents,
          feeCents: entry.feeCents,
          currency: "ETB",
          status: "success",
          verifiedAt: paidAt,
          rawPayload: JSON.stringify({ fundedBy: "wallet_balance" }),
        },
      });
      return applyDebit(tx, {
        walletId: wallet.id,
        kind: "seat",
        refId: merchOrderId,
        deltaCents: entry.amountCents,
      });
    });
  } catch (error) {
    if (error instanceof WalletError) spent = "short";
    else throw error;
  }

  if (spent === "short") return short(await balanceOf(wallet.id));
  if (spent === "claimed_elsewhere") return { settled: false, reason: "entry_not_payable" };

  const draw = await markSeatPaid({
    houseId: entry.houseId,
    label: entry.house.label,
    round: entry.round,
    seatNumber: entry.seatNumber,
    amountCents: entry.amountCents,
    accountId: entry.accountId,
    funded: "balance",
  });
  return {
    settled: true,
    kind: "seat",
    houseId: entry.houseId,
    seatNumber: entry.seatNumber,
    balanceCents: spent.balance,
    draw,
  };
}

export type BalancePayResult =
  | (Extract<SettleResult, { settled: true; kind: "seat" }> & { balanceCents: number })
  | {
      settled: false;
      reason: "insufficient_balance";
      balanceCents: number;
      requiredCents: number;
    }
  | { settled: false; reason: "not_found" | "entry_not_payable" };

export type SettleResult = {
      settled: true;
      kind: "seat";
      houseId: string;
      seatNumber: number;
      draw: Awaited<ReturnType<typeof runDrawIfComplete>>;
    }
  | {
      settled: true;
      kind: "topup";
      walletId: string;
      amountCents: number;
      balanceCents: number;
    }
  | {
      settled: false;
      reason: "already" | "unpaid" | "amount_mismatch" | "not_found" | "entry_not_payable";
      detail?: string;
    };

/** The gateway quotes decimal birr, the portal stores cents: only equal amounts settle. */
export function amountEquals(cents: number, decimal: string | null) {
  if (!decimal) return false;
  const parsed = Number(decimal);
  return Number.isFinite(parsed) && Math.round(parsed * 100) === cents;
}

type PaymentWithRefs = Prisma.PaymentGetPayload<{
  include: {
    entry: { include: { house: true } };
    wallet: { select: { id: true; accountId: true } };
  };
}>;

type EntryWithHouse = NonNullable<PaymentWithRefs["entry"]>;

/**
 * The only path that may mark a number as taken: a gateway confirmation that
 * matches the stored amount, claimed compare-and-set so the racing browser and
 * server legs cannot double-settle.
 */
export async function settlePayment(merchOrderId: string): Promise<SettleResult> {
  const payment = await prisma.payment.findUnique({
    where: { merchOrderId },
    include: {
      entry: { include: { house: true } },
      wallet: { select: { id: true, accountId: true } },
    },
  });
  if (!payment) return { settled: false, reason: "not_found" };
  if (payment.status === "success") return { settled: false, reason: "already" };

  const resolution = resolveMode();
  if ("error" in resolution) return { settled: false, reason: "unpaid", detail: resolution.error };

  if (resolution.mode === "telebirr") {
    if (!resolution.client) return { settled: false, reason: "unpaid", detail: "no client" };
    const status = await resolution.client.queryOrder(merchOrderId);
    if (!status.paid) return { settled: false, reason: "unpaid", detail: status.tradeStatus };
    if (!amountEquals(payment.amountCents, status.amount)) {
      return { settled: false, reason: "amount_mismatch", detail: status.amount ?? "" };
    }
    return confirm(payment, status.telebirrOrderId, JSON.stringify(status.raw));
  }

  if (process.env.NODE_ENV === "production") {
    return { settled: false, reason: "unpaid", detail: "simulate disabled" };
  }
  return confirm(payment, null, JSON.stringify({ simulated: true }));
}

/** A gateway confirmation is only trustworthy once it carries an order id. */
function confirm(
  payment: PaymentWithRefs,
  telebirrOrderId: string | null,
  rawPayload: string,
): Promise<SettleResult> {
  if (payment.purpose === "topup") return confirmTopup(payment, telebirrOrderId, rawPayload);
  if (!payment.entry) return Promise.resolve({ settled: false, reason: "not_found" });
  return confirmSeat(payment, payment.entry, telebirrOrderId, rawPayload);
}

async function confirmTopup(
  payment: PaymentWithRefs,
  telebirrOrderId: string | null,
  rawPayload: string,
): Promise<SettleResult> {
  const wallet = payment.wallet;
  if (!wallet) return { settled: false, reason: "not_found" };

  // credited before the payment row is stamped: a process that dies in between
  // leaves an open order the reconciler settles again, and the ledger's unique
  // key turns that second attempt into a no-op instead of double money
  const credited = await credit({
    walletId: wallet.id,
    kind: "topup",
    refId: payment.merchOrderId,
    deltaCents: payment.amountCents,
  });
  const stamped = await prisma.payment.updateMany({
    where: { id: payment.id, status: { not: "success" } },
    data: { status: "success", telebirrOrderId, rawPayload, verifiedAt: new Date() },
  });
  if (stamped.count === 0) return { settled: false, reason: "already" };

  await emitAlert(
    "wallet_topup",
    walletTopupAlert({ merchOrderId: payment.merchOrderId, amountCents: payment.amountCents }),
  );
  await notifyTopup({
    accountId: wallet.accountId,
    cents: payment.amountCents,
    balanceCents: credited.balance,
  });
  return {
    settled: true,
    kind: "topup",
    walletId: wallet.id,
    amountCents: payment.amountCents,
    balanceCents: credited.balance,
  };
}

async function confirmSeat(
  payment: PaymentWithRefs,
  entry: EntryWithHouse,
  telebirrOrderId: string | null,
  rawPayload: string,
): Promise<SettleResult> {
  const paidAt = new Date();
  // A hold can expire while the participant is still at the gateway. Only an
  // entry still awaiting payment may become paid, otherwise one number ends up
  // with two paid rows and the round can never reach its full count.
  const claimed = await claimEntry(prisma, entry.id, paidAt);
  if (!claimed) {
    await prisma.payment.update({
      where: { id: payment.id },
      data: { status: "failed", telebirrOrderId, rawPayload, verifiedAt: paidAt },
    });
    // real money confirmed by the gateway for a number that has already moved on:
    // it has to be handed back, so this must not stay silent
    if (telebirrOrderId) {
      await emitAlert(
        "orphan_payment",
        orphanPaymentAlert({
          merchOrderId: payment.merchOrderId,
          label: entry.house.label,
          seatNumber: entry.seatNumber,
          amountCents: payment.amountCents,
        }),
      );
    }
    return { settled: false, reason: "entry_not_payable", detail: entry.status };
  }

  await prisma.payment.updateMany({
    where: { id: payment.id, status: { not: "success" } },
    data: {
      status: "success",
      telebirrOrderId,
      rawPayload,
      verifiedAt: paidAt,
    },
  });

  const draw = await markSeatPaid({
    houseId: entry.houseId,
    label: entry.house.label,
    round: entry.round,
    seatNumber: entry.seatNumber,
    amountCents: payment.amountCents,
    accountId: entry.accountId,
    funded: "gateway",
  });
  return { settled: true, kind: "seat", houseId: entry.houseId, seatNumber: entry.seatNumber, draw };
}

/**
 * A number still awaiting payment becomes paid. The compare-and-set is what
 * makes the gateway callback, the browser return leg and the reconciler safe to
 * run at the same moment.
 */
async function claimEntry(db: Prisma.TransactionClient, entryId: string, paidAt: Date) {
  const claimed = await db.entry.updateMany({
    where: { id: entryId, status: "pending_payment" },
    data: { status: "paid", paidAt },
  });
  return claimed.count === 1;
}

/**
 * Everything that follows a number becoming paid: seat, draw, alerts, notices.
 * `funded` keeps the two kinds of money apart in the owner's log — a balance
 * payment spends cash that Telebirr already reported at top-up time.
 */
async function markSeatPaid(
  input: {
    houseId: string;
    label: string;
    round: number;
    seatNumber: number;
    amountCents: number;
    accountId: string;
    funded: "gateway" | "balance";
  },
) {
  await prisma.seat.updateMany({
    where: { houseId: input.houseId, number: input.seatNumber, status: { in: ["held", "open"] } },
    data: { status: "paid", heldUntil: null },
  });

  const draw = await runDrawIfComplete(input.houseId);
  if (input.funded === "balance") {
    await emitAlert(
      "seat_from_balance",
      seatFromBalanceAlert({
        label: input.label,
        round: input.round,
        seatNumber: input.seatNumber,
        amountCents: input.amountCents,
      }),
    );
  } else {
    await emitAlert(
      "payment_settled",
      paymentSettledAlert({
        label: input.label,
        round: input.round,
        seatNumber: input.seatNumber,
        amountCents: input.amountCents,
      }),
    );
  }
  await notifyPaymentSettled({
    accountId: input.accountId,
    label: input.label,
    round: input.round,
    seatNumber: input.seatNumber,
    fromBalance: input.funded === "balance",
  });
  if (isDrawSettled(draw)) await alertDrawSettled(draw);
  return draw;
}
