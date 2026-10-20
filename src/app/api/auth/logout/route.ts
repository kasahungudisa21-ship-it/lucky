import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { sessionCookieName } from "@/lib/auth";

export async function POST() {
  const store = await cookies();
  store.delete(sessionCookieName);
  return NextResponse.json({ ok: true });
}
