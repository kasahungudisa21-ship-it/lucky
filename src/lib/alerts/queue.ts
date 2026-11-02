import { prisma } from "@/lib/db";
import { alertsEnabled, outgoingChannels } from "./config";
import { deliver } from "./send";
import type { AlertBody } from "./templates";

export type AlertEventName =
  | "payment_settled"
  | "draw_settled"
  | "hold_expired"
  | "orphan_payment"
  | "gateway_error"
  | "wallet_topup"
  | "seat_from_balance"
  | "withdrawal_requested";

const MAX_ATTEMPTS = 4;
const STALE_SENDING_MS = 120_000;
/** the gateway can fail every tick; one alert per half hour is enough */
const REPEAT_WINDOW_MS = 30 * 60_000;

const backoffAt = (now: Date, attempts: number) =>
  new Date(now.getTime() + Math.min(3_600_000, 30_000 * 2 ** attempts));

/** Without a key in the environment nothing may be queued at all. */
export function alertsReady() {
  return alertsEnabled() && outgoingChannels().length > 0;
}

/**
 * Records an event on the dashboard feed and, when a transport is configured,
 * queues one row per channel. Never throws: an alert that cannot be written must
 * not undo a payment that was already confirmed by the gateway.
 */
export async function emitAlert(event: AlertEventName, body: AlertBody) {
  try {
    const now = new Date();
    if (event === "gateway_error") {
      const recent = await prisma.alert.findFirst({
        where: { event, createdAt: { gt: new Date(now.getTime() - REPEAT_WINDOW_MS) } },
        select: { id: true },
      });
      if (recent) return;
    }

    const channels = ["dashboard", ...outgoingChannels()] as const;
    await prisma.alert.createMany({
      data: channels.map((channel) => ({
        event,
        channel,
        subject: body.subject,
        body: body.text,
        status: channel === "dashboard" ? "sent" : "pending",
        runAt: now,
      })),
    });
  } catch (error) {
    console.error("alert queue failed", (error as Error).name);
  }
}

export type DispatchResult = { sent: number; queued: number; failed: number };

/** Sends everything due, with a retry backoff, and returns what happened. */
export async function dispatchAlerts(now = new Date(), limit = 10): Promise<DispatchResult> {
  const result = { sent: 0, queued: 0, failed: 0 };
  if (!alertsEnabled()) return result;

  // a process that died mid-send must not strand the row in "sending"
  await prisma.alert.updateMany({
    where: { status: "sending", updatedAt: { lt: new Date(now.getTime() - STALE_SENDING_MS) } },
    data: { status: "pending", runAt: now },
  });

  const due = await prisma.alert.findMany({
    where: {
      channel: { not: "dashboard" },
      status: "pending",
      runAt: { lte: now },
      attempts: { lt: MAX_ATTEMPTS },
    },
    orderBy: { runAt: "asc" },
    take: limit,
  });

  for (const alert of due) {
    const claimed = await prisma.alert.updateMany({
      where: { id: alert.id, status: "pending" },
      data: { status: "sending", attempts: { increment: 1 } },
    });
    if (claimed.count !== 1) continue;

    const attempts = alert.attempts + 1;
    try {
      await deliver(alert.channel, alert.subject ?? "", alert.body);
      await prisma.alert.update({
        where: { id: alert.id },
        data: { status: "sent", lastError: null },
      });
      result.sent += 1;
    } catch (error) {
      const detail = (error as Error).message?.slice(0, 200) ?? "unknown";
      await prisma.alert.update({
        where: { id: alert.id },
        data: {
          status: attempts >= MAX_ATTEMPTS ? "failed" : "pending",
          lastError: detail,
          runAt: backoffAt(now, attempts),
        },
      });
      if (attempts >= MAX_ATTEMPTS) result.failed += 1;
      else result.queued += 1;
    }
  }

  return result;
}
