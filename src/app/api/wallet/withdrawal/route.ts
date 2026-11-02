import { NextResponse } from "next/server";
import { z } from "zod";
import { currentAccount } from "@/lib/auth";
import { requestWithdrawal } from "@/lib/services/withdrawals";

const bodySchema = z.object({ amountCents: z.number() });

const reasonStatus: Record<string, number> = {
  invalid_amount: 400,
  pending_exists: 409,
  insufficient_balance: 402,
};

export async function POST(request: Request) {
  const account = await currentAccount();
  if (!account) return NextResponse.json({ error: "sign_in" }, { status: 401 });

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid_amount" }, { status: 400 });

  const result = await requestWithdrawal({ accountId: account.accountId, amountCents: parsed.data.amountCents });
  if (result.ok) return NextResponse.json({ requested: true, status: result.status, balanceCents: result.balanceCents });
  return NextResponse.json(
    { error: result.reason, balanceCents: result.balanceCents, requiredCents: result.requiredCents },
    { status: reasonStatus[result.reason] ?? 400 },
  );
}
