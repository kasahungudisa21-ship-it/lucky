import { NextResponse } from "next/server";
import { currentAccount } from "@/lib/auth";
import { paySeatFromBalance } from "@/lib/services/payments";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ entryId: string }> },
) {
  const account = await currentAccount();
  if (!account) return NextResponse.json({ error: "sign_in" }, { status: 401 });

  const { entryId } = await params;
  const result = await paySeatFromBalance({ entryId, accountId: account.accountId });
  if (result.settled) {
    return NextResponse.json({
      paid: true,
      seatNumber: result.seatNumber,
      balanceCents: result.balanceCents,
    });
  }
  // a number that has moved on is a conflict; the wallet simply not covering it
  // is the one case the participant can act on by topping up
  if (result.reason === "insufficient_balance") {
    return NextResponse.json(
      { error: result.reason, balanceCents: result.balanceCents, requiredCents: result.requiredCents },
      { status: 402 },
    );
  }
  return NextResponse.json({ error: result.reason }, { status: 409 });
}
