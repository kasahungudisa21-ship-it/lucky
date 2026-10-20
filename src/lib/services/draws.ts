import { createHash, randomBytes } from "node:crypto";
import { prisma } from "@/lib/db";
import { entryPriceCents, prizeShares } from "@/lib/pricing";

const UINT64_MAX = 2n ** 64n - 1n;

/**
 * Unbiased index over `count` participants derived only from the stored seed,
 * so a published (seed, participant list) pair can be re-checked by anyone.
 * Each place draws with its own salt, so the three values stay independent even
 * though they come from the same seed.
 */
function pickIndex(seed: Buffer, count: number, place: number): number {
  const modulus = BigInt(count);
  const rejectionLimit = (UINT64_MAX / modulus) * modulus;
  for (let counter = 0; ; counter += 1) {
    const digest = createHash("sha256")
      .update(seed)
      .update(`place-${place}`)
      .update(String(counter))
      .digest();
    const value = digest.readBigUInt64BE(0);
    if (value < rejectionLimit) return Number(value % modulus);
  }
}

type Contender = { id: string; seatNumber: number };

/** 1st, 2nd and 3rd drawn without replacement, in that order. */
function pickPlaces(seed: Buffer, pool: Contender[]): Contender[] {
  const remaining = [...pool];
  const places: Contender[] = [];
  for (let place = 1; place <= 3; place += 1) {
    places.push(remaining.splice(pickIndex(seed, remaining.length, place), 1)[0]);
  }
  return places;
}

export type DrawResult = {
  drawId: string;
  round: number;
  label: string;
  winnerSeatNumber: number;
  secondSeatNumber: number;
  thirdSeatNumber: number;
  firstCents: number;
  secondCents: number;
  thirdCents: number;
  participantCount: number;
  potCents: number;
};

export type DrawSkipReason = "not_complete" | "fewer_than_two_participants" | "closed";

/**
 * A house draws automatically once every slot in the current round is paid.
 * Settlement is compare-and-set on (houseId, round), so racing payment
 * confirmations can only ever produce one draw per round.
 */
export async function runDrawIfComplete(
  houseId: string,
): Promise<DrawResult | { skipped: DrawSkipReason }> {
  const house = await prisma.house.findUnique({ where: { id: houseId } });
  if (!house) return { skipped: "closed" };
  if (!house.isOpen) return { skipped: "closed" };

  const paid = await prisma.entry.findMany({
    where: { houseId, round: house.round, status: "paid" },
    orderBy: { seatNumber: "asc" },
  });

  if (paid.length !== house.capacity) return { skipped: "not_complete" };
  if (paid.length < 2) return { skipped: "fewer_than_two_participants" };

  const seed = randomBytes(32);
  const entropyHex = seed.toString("hex");

  const orderedIds = paid.map((entry) => entry.id).join("|");
  const commitment = createHash("sha256").update(`${entropyHex}|${orderedIds}`).digest("hex");
  const [first, second, third] = pickPlaces(seed, paid);
  // the pot is made of house prices only — the service charge each participant
  // also paid is platform revenue and never enters it
  const potCents = paid.reduce((total, entry) => total + entryPriceCents(entry), 0);
  const shares = prizeShares(potCents);
  const prizeIds = new Set([first.id, second.id, third.id]);
  const settledAt = new Date();

  return prisma.$transaction(async (tx) => {
    const claimed = await tx.house.updateMany({
      where: { id: houseId, round: house.round, isOpen: true },
      data: { round: house.round + 1, isOpen: true },
    });
    if (claimed.count !== 1) return { skipped: "not_complete" as const };

    const draw = await tx.draw.create({
      data: {
        houseId,
        round: house.round,
        participantCount: paid.length,
        potCents,
        winnerEntryId: first.id,
        winnerSeatNumber: first.seatNumber,
        firstCents: shares.firstCents,
        secondEntryId: second.id,
        secondSeatNumber: second.seatNumber,
        secondCents: shares.secondCents,
        thirdEntryId: third.id,
        thirdSeatNumber: third.seatNumber,
        thirdCents: shares.thirdCents,
        entropy: entropyHex,
        commitment,
        payoutStatus: "pending",
      },
    });

    await tx.entry.updateMany({
      where: { houseId, round: house.round, status: "paid", id: { in: [...prizeIds] } },
      data: { status: "won", settledAt },
    });
    await tx.entry.updateMany({
      where: { houseId, round: house.round, status: "paid", id: { notIn: [...prizeIds] } },
      data: { status: "lost", settledAt },
    });
    // the next round starts with an empty house
    await tx.seat.updateMany({
      where: { houseId },
      data: { status: "open", heldUntil: null },
    });

    return {
      drawId: draw.id,
      round: draw.round,
      label: house.label,
      winnerSeatNumber: draw.winnerSeatNumber,
      secondSeatNumber: second.seatNumber,
      thirdSeatNumber: third.seatNumber,
      firstCents: draw.firstCents,
      secondCents: draw.secondCents,
      thirdCents: draw.thirdCents,
      participantCount: draw.participantCount,
      potCents: draw.potCents,
    } satisfies DrawResult;
  });
}

/** Houses whose current round has every slot paid — the scheduled-draw sweep. */
export async function completeHouseIds(): Promise<string[]> {
  const houses = await prisma.house.findMany({
    where: { isOpen: true },
    select: { id: true, capacity: true, round: true },
  });
  const counts = await prisma.entry.groupBy({
    by: ["houseId", "round"],
    where: { status: "paid", houseId: { in: houses.map((house) => house.id) } },
    _count: { _all: true },
  });
  const paidBy = new Map(counts.map((row) => [`${row.houseId}:${row.round}`, row._count._all]));
  return houses
    .filter((house) => paidBy.get(`${house.id}:${house.round}`) === house.capacity)
    .map((house) => house.id);
}

export function verifyDrawCommitment(entropyHex: string, orderedEntryIds: string[], expected: string) {
  return createHash("sha256").update(`${entropyHex}|${orderedEntryIds.join("|")}`).digest("hex") === expected;
}
