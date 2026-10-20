import { prisma } from "@/lib/db";
import { SEAT_HOLD_MINUTES } from "@/lib/houses";
import { serviceFeeCents } from "@/lib/pricing";

export class ClaimError extends Error {
  constructor(readonly reason: "house_closed" | "number_taken" | "already_holds_number" | "number_out_of_range") {
    super(reason);
    this.name = "ClaimError";
  }
}

const holdDeadline = () => new Date(Date.now() + SEAT_HOLD_MINUTES * 60_000);

/** A participant may hold at most one number per house at a time. */
export async function activeEntry(accountId: string, houseId: string) {
  return prisma.entry.findFirst({
    where: {
      accountId,
      houseId,
      status: { in: ["pending_payment", "paid"] },
    },
    include: { house: { select: { capacity: true, round: true } } },
  });
}

/**
 * Claiming a number is a compare-and-set on the seat row: two participants
 * choosing the same number at the same moment cannot both win the slot.
 */
export async function claimNumber(input: { accountId: string; houseId: string; number: number }) {
  const house = await prisma.house.findUnique({ where: { id: input.houseId } });
  if (!house || !house.isOpen) throw new ClaimError("house_closed");
  if (!Number.isInteger(input.number) || input.number < 1 || input.number > house.capacity) {
    throw new ClaimError("number_out_of_range");
  }

  const existing = await activeEntry(input.accountId, input.houseId);
  if (existing && existing.seatNumber !== input.number) throw new ClaimError("already_holds_number");
  if (existing) return existing;

  return prisma.$transaction(async (tx) => {
    const seat = await tx.seat.findUnique({ where: { houseId_number: { houseId: input.houseId, number: input.number } } });
    if (!seat) throw new ClaimError("number_out_of_range");

    const taken = await tx.seat.updateMany({
      where: { id: seat.id, status: "open" },
      data: { status: "held", heldUntil: holdDeadline() },
    });
    if (taken.count !== 1) throw new ClaimError("number_taken");

    return tx.entry.create({
      data: {
        houseId: input.houseId,
        round: house.round,
        seatNumber: input.number,
        accountId: input.accountId,
        amountCents: house.priceCents,
        feeCents: serviceFeeCents(house),
        status: "pending_payment",
      },
    });
  });
}

export async function releaseEntry(input: { entryId: string; accountId: string }) {
  return prisma.$transaction(async (tx) => {
    const entry = await tx.entry.findFirst({
      where: { id: input.entryId, accountId: input.accountId, status: "pending_payment" },
    });
    if (!entry) return null;

    await tx.seat.updateMany({
      where: { houseId: entry.houseId, number: entry.seatNumber, status: "held" },
      data: { status: "open", heldUntil: null },
    });
    return tx.entry.update({ where: { id: entry.id }, data: { status: "released", settledAt: new Date() } });
  });
}

/** Held numbers that were never paid return to the pool. */
export type ReleasedSeat = { houseId: string; seatNumber: number };

export async function releaseExpiredHolds(now = new Date()): Promise<ReleasedSeat[]> {
  const staleSeats = await prisma.seat.findMany({
    where: { status: "held", heldUntil: { lt: now } },
    select: { houseId: true, number: true },
  });

  const released: ReleasedSeat[] = [];
  for (const seat of staleSeats) {
    const changed = await prisma.$transaction(async (tx) => {
      const entry = await tx.entry.updateMany({
        where: {
          houseId: seat.houseId,
          seatNumber: seat.number,
          status: "pending_payment",
        },
        data: { status: "released", settledAt: now },
      });
      await tx.seat.updateMany({
        where: { houseId: seat.houseId, number: seat.number, status: "held" },
        data: { status: "open", heldUntil: null },
      });
      return entry.count;
    });
    if (changed > 0) released.push({ houseId: seat.houseId, seatNumber: seat.number });
  }
  return released;
}
