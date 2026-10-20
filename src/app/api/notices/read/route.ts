import { NextResponse } from "next/server";
import { currentAccount } from "@/lib/auth";
import { markNoticesRead } from "@/lib/repo";

/** Clears the unread badge on the participant's own feed. */
export async function POST() {
  const account = await currentAccount();
  if (!account) return NextResponse.json({ error: "sign_in" }, { status: 401 });

  const marked = await markNoticesRead(account.accountId);
  return NextResponse.json({ marked });
}
