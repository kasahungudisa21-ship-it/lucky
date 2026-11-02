import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";

/**
 * Wallet money. The balance is never stored: it is the sum of the ledger, so it
 * cannot drift away from what actually happened. Each event writes exactly one
 * row, guarded by the unique key on (wallet, kind, reference), which is what
 * makes a retried gateway settlement or a replayed draw harmless.
 */

export type LedgerKind = "topup" | "seat" | "prize" | "withdrawal" | "refund";

export class WalletError extends Error {
  constructor(readonly reason: "insufficient_balance") {
    super(reason);
    this.name = "WalletError";
  }
}

export const TOPUP_MIN_CENTS = 1_000;
export const TOPUP_MAX_CENTS = 500_000;

/**
 * Registration creates the wallet with the account, so this only matters for an
 * account older than the ledger: two parallel requests would both find nothing,
 * and the unique accountId is what stops the second write from being a second
 * wallet.
 */
export async function walletOfAccount(accountId: string) {
  const existing = await prisma.wallet.findUnique({ where: { accountId } });
  if (existing) return existing;
  try {
    return await prisma.wallet.create({ data: { accountId } });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const raced = await prisma.wallet.findUnique({ where: { accountId } });
      if (raced) return raced;
    }
    throw error;
  }
}

export async function balanceOf(walletId: string): Promise<number> {
  const sum = await prisma.ledgerEntry.aggregate({
    where: { walletId },
    _sum: { deltaCents: true },
  });
  return sum._sum.deltaCents ?? 0;
}

/** Adds money. Crediting the same reference twice leaves the balance unchanged. */
export async function credit(input: {
  walletId: string;
  kind: LedgerKind;
  refId: string;
  deltaCents: number;
}) {
  if (input.deltaCents <= 0) throw new Error("credit needs a positive amount");
  const before = await balanceOf(input.walletId);
  try {
    await prisma.ledgerEntry.create({
      data: {
        walletId: input.walletId,
        kind: input.kind,
        refId: input.refId,
        deltaCents: input.deltaCents,
      },
    });
  } catch (error) {
    // the unique key is the idempotency guard, not an error to report
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return { balance: before, alreadyApplied: true };
    }
    throw error;
  }
  return { balance: before + input.deltaCents, alreadyApplied: false };
}

/** Takes money out, and never lets a balance go below zero. */
export async function debit(input: {
  walletId: string;
  kind: LedgerKind;
  refId: string;
  deltaCents: number;
}) {
  return prisma.$transaction(async (tx) => applyDebit(tx, input));
}

/**
 * The movement itself, so a caller that is already inside a transaction can make
 * the write that spends the balance and the write that debits it commit
 * together. Throwing is what rolls the pair back.
 */
export async function applyDebit(
  tx: Prisma.TransactionClient,
  input: { walletId: string; kind: LedgerKind; refId: string; deltaCents: number },
) {
  if (input.deltaCents <= 0) throw new Error("debit needs a positive amount");
  try {
    await tx.ledgerEntry.create({
      data: {
        walletId: input.walletId,
        kind: input.kind,
        refId: input.refId,
        deltaCents: -input.deltaCents,
      },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const sum = await tx.ledgerEntry.aggregate({
        where: { walletId: input.walletId },
        _sum: { deltaCents: true },
      });
      return { balance: sum._sum.deltaCents ?? 0, alreadyApplied: true };
    }
    throw error;
  }
  // the write above holds the lock, so this sum sees every committed movement
  const sum = await tx.ledgerEntry.aggregate({
    where: { walletId: input.walletId },
    _sum: { deltaCents: true },
  });
  const balance = sum._sum.deltaCents ?? 0;
  if (balance < 0) throw new WalletError("insufficient_balance");
  return { balance, alreadyApplied: false };
}
