import { prisma } from "@/lib/db";
import { emitAlert } from "@/lib/alerts/queue";
import { drawSettledAlert, holdExpiredAlert } from "@/lib/alerts/templates";
import { notifyDrawResult } from "@/lib/notices/participants";
import { completeHouseIds, runDrawIfComplete, type DrawResult, type DrawSkipReason } from "./draws";
import { releaseExpiredHolds, type ReleasedSeat } from "./entries";

export function isDrawSettled(
  result: DrawResult | { skipped: DrawSkipReason },
): result is DrawResult {
  return "drawId" in result;
}

/** One owner message per house, listing every number that came back. */
async function alertExpiredSeats(released: ReleasedSeat[]) {
  if (released.length === 0) return;
  const byHouse = new Map<string, number[]>();
  for (const seat of released) {
    byHouse.set(seat.houseId, [...(byHouse.get(seat.houseId) ?? []), seat.seatNumber]);
  }
  const houses = await prisma.house.findMany({
    where: { id: { in: [...byHouse.keys()] } },
    select: { id: true, label: true },
  });
  for (const house of houses) {
    const numbers = (byHouse.get(house.id) ?? []).sort((a, b) => a - b);
    await emitAlert("hold_expired", holdExpiredAlert({ label: house.label, numbers }));
  }
}

/** One owner message per house, and one notice per participant of that round. */
export async function alertDrawSettled(draw: DrawResult) {
  await emitAlert(
    "draw_settled",
    drawSettledAlert({
      label: draw.label,
      round: draw.round,
      participantCount: draw.participantCount,
      potCents: draw.potCents,
      first: { seatNumber: draw.winnerSeatNumber, cents: draw.firstCents },
      second: { seatNumber: draw.secondSeatNumber, cents: draw.secondCents },
      third: { seatNumber: draw.thirdSeatNumber, cents: draw.thirdCents },
    }),
  );
  await notifyDrawResult(draw);
}

export type SweepResult = { released: number; checked: number; draws: DrawResult[] };

/**
 * The job the scheduler runs and the cron endpoint exposes: expired holds go back
 * to the pool, then any house that is fully paid draws. Payments settle the draw
 * inline, this catches a house that filled while a confirmation was being retried.
 */
export async function runScheduledSweep(): Promise<SweepResult> {
  const expired = await releaseExpiredHolds();
  await alertExpiredSeats(expired);

  const houseIds = await completeHouseIds();
  const draws: DrawResult[] = [];
  for (const houseId of houseIds) {
    const result = await runDrawIfComplete(houseId);
    if (isDrawSettled(result)) {
      draws.push(result);
      await alertDrawSettled(result);
    }
  }

  return { released: expired.length, checked: houseIds.length, draws };
}
