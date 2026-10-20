import { NextResponse } from "next/server";
import { currentAccount } from "@/lib/auth";
import { isMerchantWallet } from "@/lib/telebirr/config";
import { runDrawIfComplete } from "@/lib/services/draws";
import { alertDrawSettled, isDrawSettled } from "@/lib/services/sweep";

/**
 * The same check the payment confirmation and the scheduled sweep make, handed
 * to the wallet that receives the money: a house whose last number was paid but
 * whose draw did not land can be pushed through by hand. A round that is not
 * fully paid is reported back and left exactly as it was.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ houseId: string }> },
) {
  const account = await currentAccount();
  if (!account) return NextResponse.json({ error: "sign_in" }, { status: 401 });
  if (!isMerchantWallet(account.phone)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { houseId } = await params;
  const result = await runDrawIfComplete(houseId);
  if (!isDrawSettled(result)) return NextResponse.json({ drawn: false, reason: result.skipped });

  await alertDrawSettled(result);
  return NextResponse.json({ drawn: true, round: result.round });
}
