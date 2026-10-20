import { randomBytes } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { centsToTelebirrAmount } from "@/lib/money";
import { TelebirrClient, TelebirrApiError } from "@/lib/telebirr/client";
import { missingTelebirrVariables, readTelebirrConfig } from "@/lib/telebirr/config";
import { emitAlert } from "@/lib/alerts/queue";
import { orphanPaymentAlert, paymentSettledAlert } from "@/lib/alerts/templates";
import { notifyPaymentSettled } from "@/lib/notices/participants";
import { runDrawIfComplete } from "./draws";
import { alertDrawSettled, isDrawSettled } from "./sweep";

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

export type SettleResult =
  | { settled: true; houseId: string; seatNumber: number; draw: Awaited<ReturnType<typeof runDrawIfComplete>> }
  | {
      settled: false;
      reason: "already" | "unpaid" | "amount_mismatch" | "not_found" | "entry_not_payable";
      detail?: string;
    };

function amountEquals(cents: number, decimal: string | null) {
  if (!decimal) return false;
  const parsed = Number(decimal);
  return Number.isFinite(parsed) && Math.round(parsed * 100) === cents;
}

type PaymentWithEntry = Prisma.PaymentGetPayload<{
  include: { entry: { include: { house: true } } };
}>;

/**
 * The only path that may mark a number as taken: a gateway confirmation that
 * matches the stored amount, claimed compare-and-set so the racing browser and
 * server legs cannot double-settle.
 */
export async function settlePayment(merchOrderId: string): Promise<SettleResult> {
  const payment = await prisma.payment.findUnique({
    where: { merchOrderId },
    include: { entry: { include: { house: true } } },
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
    return finalize(payment, status.telebirrOrderId, JSON.stringify(status.raw));
  }

  if (process.env.NODE_ENV === "production") {
    return { settled: false, reason: "unpaid", detail: "simulate disabled" };
  }
  return finalize(payment, null, JSON.stringify({ simulated: true }));
}

async function finalize(
  payment: PaymentWithEntry,
  telebirrOrderId: string | null,
  rawPayload: string,
): Promise<SettleResult> {
  const entry = payment.entry;
  const paidAt = new Date();
  // A hold can expire while the participant is still at the gateway. Only an
  // entry still awaiting payment may become paid, otherwise one number ends up
  // with two paid rows and the round can never reach its full count.
  const claimed = await prisma.entry.updateMany({
    where: { id: entry.id, status: "pending_payment" },
    data: { status: "paid", paidAt },
  });
  if (claimed.count !== 1) {
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

  await prisma.seat.updateMany({
    where: { houseId: entry.houseId, number: entry.seatNumber, status: { in: ["held", "open"] } },
    data: { status: "paid", heldUntil: null },
  });

  const draw = await runDrawIfComplete(entry.houseId);
  await emitAlert(
    "payment_settled",
    paymentSettledAlert({
      label: entry.house.label,
      round: entry.round,
      seatNumber: entry.seatNumber,
      amountCents: payment.amountCents,
    }),
  );
  await notifyPaymentSettled({
    accountId: entry.accountId,
    label: entry.house.label,
    round: entry.round,
    seatNumber: entry.seatNumber,
  });
  if (isDrawSettled(draw)) await alertDrawSettled(draw);
  return { settled: true, houseId: entry.houseId, seatNumber: entry.seatNumber, draw };
}
