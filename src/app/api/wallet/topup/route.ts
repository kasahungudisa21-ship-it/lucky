import { NextResponse } from "next/server";
import { z } from "zod";
import { currentAccount } from "@/lib/auth";
import { TelebirrApiError } from "@/lib/telebirr/client";
import { startTopup } from "@/lib/services/payments";
import { TOPUP_MAX_CENTS, TOPUP_MIN_CENTS } from "@/lib/services/wallet";

const bodySchema = z.object({ amountCents: z.number() });

/**
 * Opens a gateway order for balance money. Settlement itself never happens here:
 * it arrives on the Telebirr legs or, in development, on the pay page.
 */
export async function POST(request: Request) {
  const account = await currentAccount();
  if (!account) return NextResponse.json({ error: "sign_in" }, { status: 401 });

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success || !Number.isInteger(parsed.data.amountCents)) {
    return NextResponse.json({ error: "invalid_amount" }, { status: 400 });
  }
  const { amountCents } = parsed.data;
  if (amountCents < TOPUP_MIN_CENTS || amountCents > TOPUP_MAX_CENTS) {
    return NextResponse.json({ error: "amount_out_of_range" }, { status: 400 });
  }

  try {
    const checkout = await startTopup({ accountId: account.accountId, amountCents });
    return NextResponse.json(checkout);
  } catch (error) {
    if (error instanceof TelebirrApiError) {
      return NextResponse.json({ error: "gateway", detail: error.message }, { status: 502 });
    }
    throw error;
  }
}
