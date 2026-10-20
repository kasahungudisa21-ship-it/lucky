import { NextResponse } from "next/server";
import { dispatchAlerts } from "@/lib/alerts/queue";
import { dispatchNotices } from "@/lib/notices/queue";
import { pollTelegramLinks } from "@/lib/notices/telegram";
import { reconcilePendingPayments } from "@/lib/services/reconcile";
import { runScheduledSweep } from "@/lib/services/sweep";

/**
 * The same pass the in-process scheduler runs, for an external cron or a host
 * that cannot keep a timer: expired holds, houses that are complete, payments the
 * gateway never called back about, the alert queue and participant notices.
 */
export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: "cron_not_configured" }, { status: 503 });

  const header = request.headers.get("authorization") ?? "";
  if (header !== `Bearer ${secret}`) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const sweep = await runScheduledSweep();
  const reconciled = await reconcilePendingPayments();
  const alerts = await dispatchAlerts();
  const notices = await dispatchNotices();
  const links = await pollTelegramLinks();

  return NextResponse.json({ ...sweep, reconciled, alerts, notices, links });
}
