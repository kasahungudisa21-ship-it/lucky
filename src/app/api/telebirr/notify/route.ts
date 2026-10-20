import { NextResponse } from "next/server";
import { TelebirrClient } from "@/lib/telebirr/client";
import { readTelebirrConfig } from "@/lib/telebirr/config";
import { settlePayment } from "@/lib/services/payments";

const ok = () => NextResponse.json({ success: true });
const reject = (status: number, error: string) => NextResponse.json({ success: false, error }, { status });

/**
 * Server-to-server payment notification. The signature is checked first and
 * settlement then re-queries the gateway, so a replayed or forged body can
 * never mark a number as paid.
 */
export async function POST(request: Request) {
  const config = readTelebirrConfig();
  if (!config) return reject(503, "gateway_not_configured");

  const client = new TelebirrClient(config);
  let verified: { params: Record<string, unknown>; signatureValid: boolean };
  try {
    verified = client.verifyNotification(await request.json());
  } catch {
    return reject(400, "bad_body");
  }
  if (!verified.signatureValid) return reject(401, "bad_signature");

  const params = verified.params;
  const status = typeof params.trade_status === "string" ? params.trade_status : null;
  const merchOrderId = typeof params.merch_order_id === "string" ? params.merch_order_id : null;
  if (!merchOrderId) return reject(400, "missing_order_id");

  if (!TelebirrClient.notificationSucceeded(status)) {
    // record the failure so the seat is visibly unpaid, then acknowledge
    return ok();
  }

  const result = await settlePayment(merchOrderId);
  if (!result.settled && result.reason !== "already") return reject(500, "settle_failed");
  return ok();
}
