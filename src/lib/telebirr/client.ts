import {
  SIGN_TYPE,
  canonicalString,
  nonceStr,
  signRequest,
  timestampSeconds,
  verifySignature,
  type RequestParams,
} from "./signer";
import type { TelebirrConfig } from "./config";

export class TelebirrApiError extends Error {
  constructor(
    message: string,
    readonly httpStatus?: number,
    readonly code?: string,
    readonly body?: string,
  ) {
    super(message);
    this.name = "TelebirrApiError";
  }
}

const SUCCESS_CODES = new Set(["00000", "0"]);
/** Refresh the fabric token this many seconds before its own expiry. */
const TOKEN_SAFETY_MARGIN = 60;
const TOKEN_FALLBACK_TTL = 300;

export type FabricToken = { value: string; expiresAt: number };

export type PreOrderResult = {
  prepayId: string;
  merchOrderId: string;
  raw: RequestParams;
};

export type OrderStatus = {
  paid: boolean;
  tradeStatus: string;
  /** decimal ETB string as the gateway reports it, e.g. "400.00" */
  amount: string | null;
  currency: string | null;
  telebirrOrderId: string | null;
  raw: RequestParams;
};

function pick(biz: RequestParams, keys: string[]): string | null {
  for (const key of keys) {
    const value = biz[key];
    if (typeof value === "string" && value !== "") return value;
    if (typeof value === "number") return String(value);
  }
  return null;
}

function parseExpiry(value: unknown, now: number): number {
  if (typeof value === "number") return value > 1e11 ? Math.floor(value / 1000) : Math.floor(value);
  if (typeof value === "string") {
    const asNumber = Number(value);
    if (Number.isFinite(asNumber) && value.trim() !== "") {
      return asNumber > 1e11 ? Math.floor(asNumber / 1000) : Math.floor(asNumber);
    }
    const asDate = Date.parse(value.includes("T") ? value : value.replace(" ", "T"));
    if (!Number.isNaN(asDate)) return Math.floor(asDate / 1000);
  }
  return now + TOKEN_FALLBACK_TTL;
}

export class TelebirrClient {
  private token: FabricToken | null = null;

  constructor(readonly config: TelebirrConfig, private readonly fetchImpl: typeof fetch = fetch) {}

  private async post(path: string, body: RequestParams, authorization?: string): Promise<RequestParams> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-APP-Key": this.config.fabricAppId,
    };
    if (authorization) headers.Authorization = authorization;

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.config.baseUrl}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
    } catch (cause) {
      throw new TelebirrApiError(
        `Telebirr ${path} transport failed: ${(cause as Error).message}. ` +
          "The sandbox gateway serves an incomplete chain; point NODE_EXTRA_CA_CERTS at its CA bundle rather than disabling verification.",
      );
    }

    const text = await response.text();
    if (!response.ok) {
      if (response.status === 401) this.token = null;
      throw new TelebirrApiError(
        `Telebirr ${path} answered ${response.status}: ${text.slice(0, 400)}`,
        response.status,
        undefined,
        text,
      );
    }

    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new TelebirrApiError(`Telebirr ${path} answered with a non-JSON body: ${text.slice(0, 200)}`);
    }
    const result = payload as RequestParams;

    const code = typeof result.code === "string" ? result.code : null;
    if (code && !SUCCESS_CODES.has(code)) {
      throw new TelebirrApiError(
        `Telebirr ${path} returned code ${code}: ${String(result.msg ?? result.message ?? "")}`,
        response.status,
        code,
        text,
      );
    }
    return result;
  }

  /** POST /payment/v1/token — header X-APP-Key, body { appSecret }. */
  async applyToken(): Promise<FabricToken> {
    const result = await this.post("/payment/v1/token", { appSecret: this.config.appSecret });
    const value = typeof result.token === "string" ? result.token : null;
    if (!value) throw new TelebirrApiError("Telebirr token response had no token field");
    const token = { value, expiresAt: parseExpiry(result.expirationDate, Math.floor(Date.now() / 1000)) };
    this.token = token;
    return token;
  }

  async getToken(): Promise<FabricToken> {
    const now = Math.floor(Date.now() / 1000);
    if (this.token && this.token.expiresAt - TOKEN_SAFETY_MARGIN > now) return this.token;
    return this.applyToken();
  }

  /** POST /payment/v1/merchant/preOrder — returns the prepay_id used by checkout. */
  async createOrder(input: {
    title: string;
    amount: string;
    merchOrderId: string;
  }): Promise<PreOrderResult> {
    const token = await this.getToken();

    const request: RequestParams = {
      timestamp: timestampSeconds(),
      nonce_str: nonceStr(),
      method: "payment.preorder",
      version: "1.0",
      biz_content: {
        notify_url: this.config.notifyUrl,
        appid: this.config.merchantAppId,
        merch_code: this.config.merchantCode,
        merch_order_id: input.merchOrderId,
        trade_type: "Checkout",
        title: input.title,
        total_amount: input.amount,
        trans_currency: "ETB",
        timeout_express: "120m",
        ...(this.config.redirectUrl ? { redirect_url: this.config.redirectUrl } : {}),
      },
    };
    request.sign = signRequest(request, this.config.privateKey);
    request.sign_type = SIGN_TYPE;

    const response = await this.post("/payment/v1/merchant/preOrder", request, token.value);
    const biz = (response.biz_content ?? {}) as RequestParams;
    const prepayId = typeof biz.prepay_id === "string" ? biz.prepay_id : null;
    if (!prepayId) {
      throw new TelebirrApiError(
        `Telebirr preOrder produced no prepay_id: ${JSON.stringify(response).slice(0, 300)}`,
      );
    }
    return { prepayId, merchOrderId: input.merchOrderId, raw: response };
  }

  /** Signed browser checkout entry point. */
  buildCheckoutUrl(prepayId: string): string {
    const params: RequestParams = {
      appid: this.config.merchantAppId,
      merch_code: this.config.merchantCode,
      nonce_str: nonceStr(),
      prepay_id: prepayId,
      timestamp: timestampSeconds(),
    };
    const sign = signRequest(params, this.config.privateKey);
    const query = new URLSearchParams({ ...toStringMap(params), sign, sign_type: SIGN_TYPE });
    return `${this.config.webBaseUrl}${query.toString()}&version=1.0&trade_type=Checkout`;
  }

  /** Server-to-server truth about an order; never trust the browser leg alone. */
  async queryOrder(merchOrderId: string): Promise<OrderStatus> {
    const token = await this.getToken();

    const request: RequestParams = {
      timestamp: timestampSeconds(),
      nonce_str: nonceStr(),
      method: "payment.queryorder",
      version: "1.0",
      biz_content: {
        appid: this.config.merchantAppId,
        merch_code: this.config.merchantCode,
        merch_order_id: merchOrderId,
      },
    };
    request.sign = signRequest(request, this.config.privateKey);
    request.sign_type = SIGN_TYPE;

    const response = await this.post("/payment/v1/merchant/queryOrder", request, token.value);
    const biz = (response.biz_content ?? {}) as RequestParams;
    const tradeStatus = pick(biz, ["order_status", "trade_status"]) ?? "";

    return {
      paid: tradeStatus.toUpperCase() === "PAY_SUCCESS",
      tradeStatus,
      amount: pick(biz, ["total_amount", "totalAmount"]),
      currency: pick(biz, ["trans_currency", "currency"]),
      telebirrOrderId: pick(biz, ["trans_id", "payment_order_id", "transId"]),
      raw: response,
    };
  }

  /**
   * A gateway notification is only evidence once its RSA-PSS signature checks
   * out against the gateway public key. Fails closed when no key is configured.
   */
  verifyNotification(body: unknown): { params: RequestParams; signatureValid: boolean } {
    const unwrapped =
      body && typeof body === "object" && "data" in body && typeof (body as RequestParams).data === "string"
        ? safeJson((body as RequestParams).data as string)
        : body;

    if (!unwrapped || typeof unwrapped !== "object") {
      throw new TelebirrApiError("Telebirr notification body was not an object");
    }
    const params = unwrapped as RequestParams;
    const sign = typeof params.sign === "string" ? params.sign : null;
    if (!sign) return { params, signatureValid: false };
    if (!this.config.publicKey) {
      return { params, signatureValid: false };
    }
    return { params, signatureValid: verifySignature(params, sign, this.config.publicKey) };
  }

  /** The success word differs per leg: notify says Completed, the rest PAY_SUCCESS. */
  static notificationSucceeded(status: string | null | undefined) {
    const upper = (status ?? "").toUpperCase();
    return upper === "COMPLETED" || upper === "PAY_SUCCESS";
  }

  /** Debug helper: the exact string that gets signed, for gateway-log triage. */
  static canonicalForDebug(params: RequestParams) {
    return canonicalString(params);
  }
}

function toStringMap(params: RequestParams): Record<string, string> {
  return Object.fromEntries(
    Object.entries(params).map(([key, value]) => [key, value === null || value === undefined ? "" : String(value)]),
  );
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
