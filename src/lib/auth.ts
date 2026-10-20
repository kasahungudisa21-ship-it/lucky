import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";

const COOKIE_NAME = "lucky_session";
const SESSION_DAYS = 30;
const SCRYPT_KEYLEN = 32;

function scrypt(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, SCRYPT_KEYLEN, (error, derived) => {
      if (error) reject(error);
      else resolve(derived);
    });
  });
}

export async function hashPin(pin: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(pin, salt);
  return `scrypt$${salt.toString("base64")}$${derived.toString("base64")}`;
}

export async function verifyPin(pin: string, stored: string): Promise<boolean> {
  const [scheme, saltPart, hashPart] = stored.split("$");
  if (scheme !== "scrypt" || !saltPart || !hashPart) return false;
  const salt = Buffer.from(saltPart, "base64");
  const expected = Buffer.from(hashPart, "base64");
  const derived = await scrypt(pin, salt);
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

function sessionSecret(): Uint8Array {
  const raw = process.env.APP_SESSION_SECRET;
  if (raw && raw.trim() !== "") return new Uint8Array(Buffer.from(raw.trim(), "hex"));
  if (process.env.NODE_ENV === "production") {
    throw new Error("APP_SESSION_SECRET must be set in production");
  }
  // Development fallback so a fresh clone runs; sessions drop on restart.
  return new Uint8Array(Buffer.from("00".repeat(32), "hex"));
}

export type SessionClaims = { accountId: string; phone: string };

export async function createSession(claims: SessionClaims): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_DAYS}d`)
    .sign(sessionSecret());
}

export async function readSessionToken(token: string): Promise<SessionClaims | null> {
  try {
    const { payload } = await jwtVerify(token, sessionSecret());
    const accountId = typeof payload.accountId === "string" ? payload.accountId : null;
    const phone = typeof payload.phone === "string" ? payload.phone : null;
    return accountId && phone ? { accountId, phone } : null;
  } catch {
    return null;
  }
}

export async function currentAccount(): Promise<SessionClaims | null> {
  const store = await cookies();
  const token = store.get(COOKIE_NAME)?.value;
  return token ? readSessionToken(token) : null;
}

export async function requireAccount(): Promise<SessionClaims> {
  const account = await currentAccount();
  if (!account) throw new Error("Not authenticated");
  return account;
}

export const sessionCookieName = COOKIE_NAME;

export function sessionCookieOptions() {
  return {
    name: COOKIE_NAME,
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_DAYS * 24 * 60 * 60,
  };
}
