import { NextResponse } from "next/server";
import { ClaimError, claimNumber, releaseEntry } from "@/lib/services/entries";
import { currentAccount } from "@/lib/auth";

const reasonStatus: Record<string, number> = {
  house_closed: 409,
  number_taken: 409,
  number_limit: 409,
  number_out_of_range: 400,
};

export async function POST(
  request: Request,
  { params }: { params: Promise<{ houseId: string; number: string }> },
) {
  const account = await currentAccount();
  if (!account) return NextResponse.json({ error: "sign_in" }, { status: 401 });

  const { houseId, number } = await params;
  try {
    const entry = await claimNumber({
      accountId: account.accountId,
      houseId,
      number: Number(number),
    });
    return NextResponse.json({ entryId: entry.id, seatNumber: entry.seatNumber });
  } catch (error) {
    if (error instanceof ClaimError) {
      return NextResponse.json({ error: error.reason }, { status: reasonStatus[error.reason] ?? 400 });
    }
    throw error;
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ houseId: string; number: string }> },
) {
  const account = await currentAccount();
  if (!account) return NextResponse.json({ error: "sign_in" }, { status: 401 });

  const { number } = await params;
  const url = new URL(request.url);
  const entryId = url.searchParams.get("entryId");
  if (!entryId) return NextResponse.json({ error: "entry_required" }, { status: 400 });

  const released = await releaseEntry({ entryId, accountId: account.accountId });
  if (!released) return NextResponse.json({ error: "not_releasable" }, { status: 409 });
  return NextResponse.json({ ok: true, seatNumber: Number(number) });
}
