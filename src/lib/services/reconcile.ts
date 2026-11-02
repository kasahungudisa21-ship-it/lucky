import { prisma } from "@/lib/db";
import { emitAlert } from "@/lib/alerts/queue";
import { gatewayErrorAlert } from "@/lib/alerts/templates";
import { resolveMode, settlePayment } from "./payments";

/** The gateway notification usually arrives first; this only covers for it. */
const GRACE_MS = 60_000;
const BATCH = 20;

export type ReconcileResult = { checked: number; settled: number; error: string | null };

/**
 * Asks Telebirr about payments that are still open. A lost notification can no
 * longer leave a paid number unconfirmed, and the draw fires from the same
 * settlement path the notification uses.
 */
export async function reconcilePendingPayments(now = new Date()): Promise<ReconcileResult> {
  const resolution = resolveMode();
  if ("error" in resolution) {
    await emitAlert("gateway_error", gatewayErrorAlert(resolution.error));
    return { checked: 0, settled: 0, error: resolution.error };
  }
  // development simulate mode has no gateway to ask, so its orders are left to
  // the test button instead of being polled against a live endpoint
  if (resolution.mode !== "telebirr") return { checked: 0, settled: 0, error: null };

  const olderThan = new Date(now.getTime() - GRACE_MS);
  const pending = await prisma.payment.findMany({
    where: {
      status: { in: ["created", "checkout_published"] },
      // a seat order is worth asking about while its number is still unpaid; a
      // top-up order has no number, so its own status is all there is
      AND: [
        {
          OR: [
            { purpose: "topup" },
            { entry: { is: { status: "pending_payment" } } },
          ],
        },
        { OR: [{ checkedAt: null }, { checkedAt: { lt: olderThan } }] },
      ],
    },
    select: { merchOrderId: true },
    orderBy: { checkedAt: "asc" },
    take: BATCH,
  });

  let settled = 0;
  for (const { merchOrderId } of pending) {
    // stamp first so an order that keeps failing cannot block the batch forever
    await prisma.payment.update({ where: { merchOrderId }, data: { checkedAt: now } });
    try {
      const result = await settlePayment(merchOrderId);
      if (result.settled) settled += 1;
    } catch (error) {
      const message = (error as Error).message ?? "gateway_unreachable";
      await emitAlert("gateway_error", gatewayErrorAlert(message));
      return { checked: pending.length, settled, error: message.slice(0, 200) };
    }
  }

  return { checked: pending.length, settled, error: null };
}
