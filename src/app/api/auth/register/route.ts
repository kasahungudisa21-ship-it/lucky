import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { createSession, hashPin, sessionCookieOptions } from "@/lib/auth";
import { normalizeEthiopianPhone } from "@/lib/validators";

const bodySchema = z.object({
  phone: z.string(),
  pin: z.string(),
  pinConfirm: z.string().optional(),
  accepted: z.boolean().optional(),
});

const bad = (error: string) => NextResponse.json({ error }, { status: 400 });

export async function POST(request: Request) {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return bad("invalid_phone");

  const phone = normalizeEthiopianPhone(parsed.data.phone);
  if (!phone) return bad("invalid_phone");
  if (!/^\d{4,6}$/.test(parsed.data.pin)) return bad("invalid_pin");
  if (parsed.data.pinConfirm !== parsed.data.pin) return bad("pin_mismatch");
  if (parsed.data.accepted !== true) return bad("accept_required");

  if (await prisma.account.findUnique({ where: { phone } })) return bad("exists");

  const account = await prisma.account.create({
    data: { phone, pinHash: await hashPin(parsed.data.pin), wallet: { create: {} } },
  });

  const store = await cookies();
  store.set({ ...sessionCookieOptions(), value: await createSession({ accountId: account.id, phone }) });

  return NextResponse.json({ ok: true });
}
