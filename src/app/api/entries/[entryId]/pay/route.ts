import { NextResponse } from "next/server";
import { TelebirrApiError } from "@/lib/telebirr/client";
import { currentAccount } from "@/lib/auth";
import { startPayment } from "@/lib/services/payments";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ entryId: string }> },
) {
  const account = await currentAccount();
  if (!account) return NextResponse.json({ error: "sign_in" }, { status: 401 });

  const { entryId } = await params;
  try {
    const checkout = await startPayment({ entryId, accountId: account.accountId });
    return NextResponse.json(checkout);
  } catch (error) {
    if (error instanceof TelebirrApiError) {
      return NextResponse.json({ error: "gateway", detail: error.message }, { status: 502 });
    }
    throw error;
  }
}
