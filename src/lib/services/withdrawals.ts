import { prisma } from "@/lib/db";
import { emitAlert } from "@/lib/alerts/queue";
import { withdrawalAlert } from "@/lib/alerts/templates";
import { notifyWithdrawalPaid } from "@/lib/notices/participants";
import { applyDebit, balanceOf, TOPUP_MIN_CENTS, walletOfAccount, WalletError } from "./wallet";

/**
 * Money leaving a wallet. The balance is only touched when the owner hands the
 * cash over: a request just books an intention, so a forgotten request cannot
 * strand money that was never paid out.
 */

class AlreadyHandled extends Error {}

export type WithdrawalOutcome =
  | { ok: true; status: "pending" | "paid" | "rejected"; balanceCents: number }
  | {
      ok: false;
      reason: "invalid_amount" | "not_found" | "already_handled" | "pending_exists" | "insufficient_balance";
      balanceCents: number;
      requiredCents?: number;
    };

export async function requestWithdrawal(input: {
  accountId: string;
  amountCents: number;
}): Promise<WithdrawalOutcome> {
  const wallet = await walletOfAccount(input.accountId);
  const balance = await balanceOf(wallet.id);
  if (!Number.isInteger(input.amountCents) || input.amountCents < TOPUP_MIN_CENTS) {
    return { ok: false, reason: "invalid_amount", balanceCents: balance };
  }
  if (balance < input.amountCents) {
    return { ok: false, reason: "insufficient_balance", balanceCents: balance, requiredCents: input.amountCents };
  }

  // one request at a time: the owner has to be able to tell which number is
  // waiting, and two open requests for the same money would be ambiguous
  if (await prisma.withdrawal.findFirst({ where: { walletId: wallet.id, status: "pending" } })) {
    return { ok: false, reason: "pending_exists", balanceCents: balance };
  }

  await prisma.withdrawal.create({ data: { walletId: wallet.id, amountCents: input.amountCents } });
  await emitAlert("withdrawal_requested", withdrawalAlert({ amountCents: input.amountCents }));
  return { ok: true, status: "pending", balanceCents: balance };
}

/** The owner's answer to a request. Only a paid one moves the balance. */
export async function resolveWithdrawal(input: {
  withdrawalId: string;
  outcome: "paid" | "rejected";
}): Promise<WithdrawalOutcome> {
  const current = await prisma.withdrawal.findUnique({
    where: { id: input.withdrawalId },
    include: { wallet: { select: { accountId: true } } },
  });
  if (!current) {
    return { ok: false, reason: "not_found", balanceCents: 0 };
  }
  if (current.status !== "pending") {
    return { ok: false, reason: "already_handled", balanceCents: await balanceOf(current.walletId) };
  }

  const settledAt = new Date();
  if (input.outcome === "rejected") {
    const moved = await prisma.withdrawal.updateMany({
      where: { id: current.id, status: "pending" },
      data: { status: "rejected", settledAt },
    });
    if (moved.count !== 1) {
      return { ok: false, reason: "already_handled", balanceCents: await balanceOf(current.walletId) };
    }
    return { ok: true, status: "rejected", balanceCents: await balanceOf(current.walletId) };
  }

  // the balance is re-checked here rather than at request time: anything spent
  // in the meantime, a prize included, has to be seen before the cash goes out
  try {
    await prisma.$transaction(async (tx) => {
      await applyDebit(tx, {
        walletId: current.walletId,
        kind: "withdrawal",
        refId: current.id,
        deltaCents: current.amountCents,
      });
      const marked = await tx.withdrawal.updateMany({
        where: { id: current.id, status: "pending" },
        data: { status: "paid", settledAt },
      });
      if (marked.count !== 1) throw new AlreadyHandled();
    });
  } catch (error) {
    if (error instanceof WalletError) {
      return {
        ok: false,
        reason: "insufficient_balance",
        balanceCents: await balanceOf(current.walletId),
        requiredCents: current.amountCents,
      };
    }
    if (error instanceof AlreadyHandled) {
      return { ok: false, reason: "already_handled", balanceCents: await balanceOf(current.walletId) };
    }
    throw error;
  }

  const balanceCents = await balanceOf(current.walletId);
  await notifyWithdrawalPaid({
    accountId: current.wallet.accountId,
    cents: current.amountCents,
    balanceCents,
  });
  return { ok: true, status: "paid", balanceCents };
}

