import { NextResponse } from "next/server";
import { currentAccount } from "@/lib/auth";
import { issueTelegramLink } from "@/lib/notices/telegram";

/**
 * A bot cannot write to a chat the participant has not opened, so this hands out
 * the one-time code that t.me link carries. The chat id is attached later by the
 * telegram job when the /start message arrives.
 */
export async function POST() {
  const account = await currentAccount();
  if (!account) return NextResponse.json({ error: "sign_in" }, { status: 401 });

  const result = await issueTelegramLink(account.accountId);
  if ("error" in result) return NextResponse.json(result, { status: 503 });
  return NextResponse.json(result);
}
