import { z } from "zod";

/** Accepts 09/07 local form and +251/251 international form, stores E.164-ish +2519XXXXXXX. */
export function normalizeEthiopianPhone(input: string): string | null {
  const digits = input.replace(/[^\d+]/g, "").replace(/^\+/, "");
  let national: string | null = null;

  if (digits.startsWith("251") && digits.length === 12) {
    national = digits.slice(3);
  } else if (/^0\d{9}$/.test(digits) && digits.length === 10) {
    national = digits.slice(1);
  } else if (/^[97]\d{8}$/.test(digits)) {
    national = digits;
  }

  if (!national || !/^[97]\d{8}$/.test(national)) return null;
  return `+251${national}`;
}

export const phoneSchema = z
  .string()
  .min(9)
  .max(20)
  .transform((value, ctx) => {
    const normalized = normalizeEthiopianPhone(value);
    if (!normalized) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "invalid_phone" });
      return z.NEVER;
    }
    return normalized;
  });

export const pinSchema = z.string().regex(/^\d{4,6}$/, "invalid_pin");

export const registerSchema = z.object({
  phone: phoneSchema,
  pin: pinSchema,
  pinConfirm: z.string(),
  accepted: z.boolean(),
});

export const loginSchema = z.object({
  phone: phoneSchema,
  pin: pinSchema,
});

export const seatChoiceSchema = z.object({
  houseId: z.string().min(1),
  number: z.coerce.number().int().min(1).max(100),
});
