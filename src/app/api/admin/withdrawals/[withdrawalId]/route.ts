import { NextResponse } from "next/server";
import { z } from "zod";
import { currentAccount } from "@/lib/auth";
import { isMerchantWallet } from "@/lib/telebirr/config";
import { resolveWithdrawal } from "@/lib/services/withdrawals";

const bodySchema = z.object({ outcome: z.union([z.literal("paid"), z.literal("rejected")]) });

/**
 * Handing the cash over, or sending the request back. The balance only moves
 * here, so a request the owner never answered cannot leave money missing.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ withdrawalId: string }> },
) {
  const account = await currentAccount();
  if (!account) return NextResponse.json({ error: "sign_in" }, { status: 401 });
  if (!isMerchantWallet(account.phone)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid_outcome" }, { status: 400 });

  const { withdrawalId } = await params;
  const result = await resolveWithdrawal({ withdrawalId, outcome: parsed.data.outcome });
  if (!result.ok) {
    const status = result.reason === "not_found" ? 404 : result.reason === "already_handled" ? 409 : 402;
    return NextResponse.json(
      { error: result.reason, balanceCents: result.balanceCents, requiredCents: result.requiredCents },
      { status },
    );
  }
  return NextResponse.json({ status: result.status, balanceCents: result.balanceCents });
}
