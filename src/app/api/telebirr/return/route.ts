import { NextResponse } from "next/server";
import { readTelebirrConfig } from "@/lib/telebirr/config";
import { settlePayment } from "@/lib/services/payments";

/**
 * The browser return leg is a hint only: it tells us which order to re-query.
 * Nothing is trusted from the query string itself.
 */
export async function GET(request: Request) {
  const config = readTelebirrConfig();
  if (!config) return NextResponse.json({ error: "gateway_not_configured" }, { status: 503 });

  const url = new URL(request.url);
  const merchOrderId = url.searchParams.get("merch_order_id") ?? "";
  if (!/^[A-Za-z0-9]+$/.test(merchOrderId)) {
    return NextResponse.json({ error: "bad_order_id" }, { status: 400 });
  }

  await settlePayment(merchOrderId);
  return NextResponse.redirect(new URL(`/pay/${merchOrderId}`, url.origin));
}
