import {
  constants,
  createPrivateKey,
  createPublicKey,
  randomInt,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from "node:crypto";

/**
 * Telebirr H5 C2B request signature process: flatten biz_content into the top
 * level, sort keys by ASCII order, join as key=value&..., sign with RSA-PSS
 * (SHA256 digest, MGF1-SHA256, 32-byte salt) and base64 the result.
 */
const EXCLUDED_FIELDS = new Set([
  "sign",
  "sign_type",
  "header",
  "refund_info",
  "openType",
  "raw_request",
  "biz_content",
]);

export const SIGN_TYPE = "SHA256WithRSA";

export type RequestParams = Record<string, unknown>;

export function canonicalString(params: RequestParams): string {
  const map = new Map<string, string>();

  const collect = (source: RequestParams) => {
    for (const [key, raw] of Object.entries(source)) {
      if (EXCLUDED_FIELDS.has(key) || raw === undefined) continue;
      map.set(key, raw === null ? "" : String(raw));
    }
  };

  collect(params);
  const biz = params.biz_content;
  if (biz && typeof biz === "object") collect(biz as RequestParams);

  return [...map.keys()]
    .sort()
    .map((key) => `${key}=${map.get(key)}`)
    .join("&");
}

/**
 * Ethio telecom issues merchant keys as bare base64 DER with no PEM armour;
 * PKCS#8 first, PKCS#1 as a fallback, then PEM text as-is.
 */
function loadPrivateKeyMaterial(source: string): KeyObject {
  const looksLikeBareBase64 = !source.includes("-----BEGIN");
  if (looksLikeBareBase64) {
    const der = Buffer.from(source.replace(/\s+/g, ""), "base64");
    for (const type of ["pkcs8", "pkcs1"] as const) {
      try {
        return createPrivateKey({ key: der, format: "der", type });
      } catch {
        // try the next encoding
      }
    }
    throw new Error("TELEBIRR_PRIVATE_KEY is not a parseable DER key");
  }
  try {
    return createPrivateKey(source);
  } catch {
    const flat = source.replace(/\\n/g, "\n");
    return createPrivateKey(flat);
  }
}

function loadPublicKeyMaterial(source: string): KeyObject {
  const looksLikeBareBase64 = !source.includes("-----BEGIN");
  if (looksLikeBareBase64) {
    const der = Buffer.from(source.replace(/\s+/g, ""), "base64");
    for (const type of ["spki", "pkcs1"] as const) {
      try {
        return createPublicKey({ key: der, format: "der", type });
      } catch {
        // try the next encoding
      }
    }
    throw new Error("TELEBIRR_PUBLIC_KEY is not a parseable DER key");
  }
  return createPublicKey(source);
}

const pssSignOptions = (key: KeyObject) => ({
  key,
  padding: constants.RSA_PKCS1_PSS_PADDING,
  saltLength: 32,
  mgf1Hash: "sha256",
});

const pssVerifyOptions = (key: KeyObject) => ({
  key,
  padding: constants.RSA_PKCS1_PSS_PADDING,
  saltLength: 32,
  mgf1Hash: "sha256",
});

export function signRequest(params: RequestParams, privateKeySource: string): string {
  const key = loadPrivateKeyMaterial(privateKeySource);
  return cryptoSign("sha256", Buffer.from(canonicalString(params), "utf8"), pssSignOptions(key)).toString(
    "base64",
  );
}

/**
 * A signature arriving in a query string has its base64 "+" decoded into a
 * space, so every plausible repair is attempted against the same public key.
 * Verification never loosens the key requirement.
 */
export function verifySignature(
  params: RequestParams,
  signature: string,
  publicKeySource: string,
): boolean {
  const key = loadPublicKeyMaterial(publicKeySource);
  const payload = Buffer.from(canonicalString(params), "utf8");

  const trimmed = signature.trim();
  const candidates = new Set<string>([trimmed, trimmed.replace(/ /g, "+")]);
  for (const candidate of [...candidates]) {
    const paddingNeeded = candidate.length % 4 === 0 ? 0 : 4 - (candidate.length % 4);
    if (paddingNeeded > 0) candidates.add(candidate + "=".repeat(paddingNeeded));
  }

  for (const candidate of candidates) {
    const bytes = Buffer.from(candidate, "base64");
    if (bytes.length === 0) continue;
    try {
      if (cryptoVerify("sha256", payload, pssVerifyOptions(key), bytes)) return true;
    } catch {
      // malformed base64 for this candidate; try the next reading
    }
  }
  return false;
}

export function timestampSeconds(): string {
  return String(Math.floor(Date.now() / 1000));
}

const NONCE_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

export function nonceStr(length = 32): string {
  return Array.from({ length }, () => NONCE_ALPHABET[randomInt(NONCE_ALPHABET.length)]).join("");
}
