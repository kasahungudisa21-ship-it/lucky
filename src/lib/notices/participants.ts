import { prisma } from "@/lib/db";
import type { DrawResult } from "@/lib/services/draws";
import { emitNotices, type NoticeInput } from "./queue";
import {
  balanceNotice,
  closedNotice,
  paymentNotice,
  topupNotice,
  withdrawalNotice,
  wonNotice,
} from "./templates";

/**
 * The participant side of an event. These are called from the same places the
 * owner alerts are, so a person who is owed a message cannot be missed by one
 * path (gateway callback, scheduled sweep or the merchant's own push).
 */

export async function notifyPaymentSettled(input: {
  accountId: string;
  label: string;
  round: number;
  seatNumber: number;
  fromBalance?: boolean;
}) {
  await emitNotices([
    {
      accountId: input.accountId,
      event: "payment_settled",
      body: input.fromBalance
        ? balanceNotice({ seatNumber: input.seatNumber })
        : paymentNotice({
            label: input.label,
            round: input.round,
            seatNumber: input.seatNumber,
          }),
    },
  ]);
}

export async function notifyTopup(input: {
  accountId: string;
  cents: number;
  balanceCents: number;
}) {
  await emitNotices([
    {
      accountId: input.accountId,
      event: "wallet_topup",
      body: topupNotice({ cents: input.cents, balanceCents: input.balanceCents }),
    },
  ]);
}

/** Sent when the owner hands the money over, not when the request is made. */
export async function notifyWithdrawalPaid(input: {
  accountId: string;
  cents: number;
  balanceCents: number;
}) {
  await emitNotices([
    {
      accountId: input.accountId,
      event: "withdrawal_paid",
      body: withdrawalNotice({ cents: input.cents, balanceCents: input.balanceCents }),
    },
  ]);
}

/**
 * Every settled entry of the finished round hears back: the three prize numbers
 * get their place and amount, everyone else gets the closing of their house.
 */
export async function notifyDrawResult(draw: DrawResult) {
  const row = await prisma.draw.findUnique({
    where: { id: draw.drawId },
    select: { houseId: true, winnerEntryId: true, secondEntryId: true, thirdEntryId: true },
  });
  if (!row) return;

  const entries = await prisma.entry.findMany({
    where: { houseId: row.houseId, round: draw.round, status: { in: ["won", "lost"] } },
    select: { id: true, accountId: true, seatNumber: true },
  });

  const placeById = new Map<string, number>([
    [row.winnerEntryId, 1],
    [row.secondEntryId ?? "", 2],
    [row.thirdEntryId ?? "", 3],
  ]);
  const centsByPlace = [draw.firstCents, draw.secondCents, draw.thirdCents];

  const inputs: NoticeInput[] = entries.map((entry) => {
    const place = placeById.get(entry.id);
    return place
      ? {
          accountId: entry.accountId,
          event: "draw_won",
          body: wonNotice({
            label: draw.label,
            round: draw.round,
            seatNumber: entry.seatNumber,
            place,
            cents: centsByPlace[place - 1],
          }),
        }
      : {
          accountId: entry.accountId,
          event: "draw_closed",
          body: closedNotice({ label: draw.label }),
        };
  });

  await emitNotices(inputs);
}
