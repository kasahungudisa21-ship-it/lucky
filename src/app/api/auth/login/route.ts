import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { createSession, sessionCookieOptions, verifyPin } from "@/lib/auth";
import { normalizeEthiopianPhone } from "@/lib/validators";

const bodySchema = z.object({ phone: z.string(), pin: z.string() });
const bad = (error: string) => NextResponse.json({ error }, { status: 400 });

export async function POST(request: Request) {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return bad("login_failed");

  const phone = normalizeEthiopianPhone(parsed.data.phone);
  if (!phone) return bad("invalid_phone");

  const account = await prisma.account.findUnique({ where: { phone } });
  if (!account) return bad("login_failed");
  if (!/^\d{4,6}$/.test(parsed.data.pin)) return bad("invalid_pin");
  if (!(await verifyPin(parsed.data.pin, account.pinHash))) return bad("login_failed");

  const store = await cookies();
  store.set({
    ...sessionCookieOptions(),
    value: await createSession({ accountId: account.id, phone: account.phone }),
  });

  return NextResponse.json({ ok: true });
}
