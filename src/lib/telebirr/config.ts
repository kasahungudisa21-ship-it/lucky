import { normalizeEthiopianPhone } from "@/lib/validators";

export type TelebirrEnvironment = "test" | "production";

export type TelebirrConfig = {
  environment: TelebirrEnvironment;
  /** server-to-server API base */
  baseUrl: string;
  /** browser checkout base, already ends with "?" */
  webBaseUrl: string;
  fabricAppId: string;
  appSecret: string;
  merchantAppId: string;
  merchantCode: string;
  /** merchant RSA private key, PEM or bare base64 DER as Ethio telecom issues it */
  privateKey: string;
  /** gateway public key used to verify notifications and return URLs */
  publicKey: string | null;
  notifyUrl: string;
  redirectUrl: string | null;
};

const API_BASE = {
  test: "https://developerportal.ethiotelebirr.et:38443/apiaccess/payment/gateway",
  production: "https://superapp.ethiomobilemoney.et:38443/apiaccess/payment/gateway",
} as const;

const WEB_BASE = {
  test: "https://developerportal.ethiotelebirr.et:38443/payment/web/paygate?",
  production: "https://superapp.ethiomobilemoney.et:38443/payment/web/paygate?",
} as const;

const REQUIRED: Array<[keyof TelebirrConfig, string]> = [
  ["fabricAppId", "TELEBIRR_FABRIC_APP_ID"],
  ["appSecret", "TELEBIRR_APP_SECRET"],
  ["merchantAppId", "TELEBIRR_MERCHANT_APP_ID"],
  ["merchantCode", "TELEBIRR_MERCHANT_CODE"],
  ["privateKey", "TELEBIRR_PRIVATE_KEY"],
  ["notifyUrl", "TELEBIRR_NOTIFY_URL"],
];

const value = (name: string) => {
  const raw = process.env[name];
  return raw && raw.trim() !== "" ? raw.trim() : undefined;
};

export function missingTelebirrVariables(): string[] {
  return REQUIRED.map(([, envName]) => envName).filter((envName) => !value(envName));
}

/** Returns null when the merchant has not been issued credentials yet. */
export function readTelebirrConfig(): TelebirrConfig | null {
  const read = (envName: string) => value(envName);

  const fabricAppId = read("TELEBIRR_FABRIC_APP_ID");
  const appSecret = read("TELEBIRR_APP_SECRET");
  const merchantAppId = read("TELEBIRR_MERCHANT_APP_ID");
  const merchantCode = read("TELEBIRR_MERCHANT_CODE");
  const privateKey = read("TELEBIRR_PRIVATE_KEY");
  const notifyUrl = read("TELEBIRR_NOTIFY_URL");
  if (!fabricAppId || !appSecret || !merchantAppId || !merchantCode || !privateKey || !notifyUrl) {
    return null;
  }

  const environment: TelebirrEnvironment =
    read("TELEBIRR_ENVIRONMENT") === "production" ? "production" : "test";

  return {
    environment,
    baseUrl: API_BASE[environment],
    webBaseUrl: WEB_BASE[environment],
    fabricAppId,
    appSecret,
    merchantAppId,
    merchantCode,
    privateKey,
    publicKey: read("TELEBIRR_PUBLIC_KEY") ?? null,
    notifyUrl,
    redirectUrl: read("TELEBIRR_REDIRECT_URL") ?? null,
  };
}

/**
 * The merchant wallet that receives every payment. It only names the payee, so
 * it stays out of the required API credentials and is never logged.
 */
export function merchantWallet(): string | null {
  return value("TELEBIRR_MERCHANT_PHONE") ?? null;
}

/** True when a signed-in phone is the wallet that receives the payments. */
export function isMerchantWallet(phone: string): boolean {
  const payee = merchantWallet();
  return payee !== null && normalizeEthiopianPhone(phone) === normalizeEthiopianPhone(payee);
}

export function isPublicNotifyUrl(url: string) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    return (
      parsed.protocol === "https:" &&
      host !== "localhost" &&
      !host.endsWith(".local") &&
      !/^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)
    );
  } catch {
    return false;
  }
}
