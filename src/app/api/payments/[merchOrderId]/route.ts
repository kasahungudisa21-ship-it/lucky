import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { currentAccount } from "@/lib/auth";
import { resolveMode, settlePayment } from "@/lib/services/payments";

/** A seat order is owned through its entry, a top-up order through its wallet. */
async function ownedPayment(merchOrderId: string, accountId: string) {
  return prisma.payment.findFirst({
    where: {
      merchOrderId,
      OR: [{ entry: { is: { accountId } } }, { wallet: { is: { accountId } } }],
    },
    include: { entry: { select: { id: true, houseId: true, seatNumber: true, status: true } } },
  });
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ merchOrderId: string }> },
) {
  const account = await currentAccount();
  if (!account) return NextResponse.json({ error: "sign_in" }, { status: 401 });

  const { merchOrderId } = await params;
  const payment = await ownedPayment(merchOrderId, account.accountId);
  if (!payment) return NextResponse.json({ error: "not_found" }, { status: 404 });

  return NextResponse.json({
    status: payment.status,
    paid: payment.status === "success",
    amountCents: payment.amountCents,
    purpose: payment.purpose,
    entryId: payment.entry?.id ?? null,
    seatNumber: payment.entry?.seatNumber ?? null,
  });
}

/**
 * Development-only settlement. Real Telebirr confirmations arrive on the
 * gateway notify and return routes, never here.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ merchOrderId: string }> },
) {
  const account = await currentAccount();
  if (!account) return NextResponse.json({ error: "sign_in" }, { status: 401 });

  const resolution = resolveMode();
  if ("error" in resolution) return NextResponse.json({ error: resolution.error }, { status: 503 });
  if (resolution.mode !== "simulate") {
    return NextResponse.json({ error: "gateway_confirms_only" }, { status: 403 });
  }

  const { merchOrderId } = await params;
  const payment = await ownedPayment(merchOrderId, account.accountId);
  if (!payment) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const result = await settlePayment(merchOrderId);
  return NextResponse.json(result);
}
