/**
 * Dry run of the real-money payment path, with no money and no network.
 *
 *   npm run check:gateway
 *
 * The gateway legs — token, preOrder, checkout link, queryOrder, notification — are
 * exercised against an in-process mock that answers the way the Telebirr gateway
 * does, so the adapter is proven before PAYMENT_MODE is ever switched. The merchant
 * credentials are inspected for shape only (a key that parses, a notify URL the
 * gateway can actually reach); no value is ever printed. Nothing here opens a
 * connection or writes to the database.
 */
import { generateKeyPairSync } from "node:crypto";
import { TelebirrApiError, TelebirrClient } from "../src/lib/telebirr/client.ts";
import { isPublicNotifyUrl, merchantWallet, readTelebirrConfig } from "../src/lib/telebirr/config.ts";
import { signRequest, verifySignature } from "../src/lib/telebirr/signer.ts";
import { amountEquals, newMerchOrderId, resolveMode } from "../src/lib/services/payments.ts";
import { centsToTelebirrAmount } from "../src/lib/money.ts";

const results = [];
function check(name, condition, detail = "") {
  results.push({ name, pass: Boolean(condition), detail });
  console.log(`${condition ? "ok  " : "FAIL"} ${name}${condition ? "" : ` -- ${detail}`}`);
}
/** Something worth reading that cannot be concluded as a pass or a fail. */
const info = (label, value) => console.log(`info ${label}: ${value}`);

const exportPem = (key, type) => key.export({ type, format: "pem" }).toString();
const merchantKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const gatewayKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });

const AMOUNT = "400.00";
const MOCK_HOST = "telebirr.mock.invalid";

/** The gateway as the adapter sees it: same paths, same envelopes, no network. */
function mockGateway(behaviour = {}) {
  const calls = [];
  let tokensIssued = 0;
  let refused401 = false;

  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body ?? "{}");
    calls.push({ url, headers: init.headers, body });
    const json = (payload, status = 200) =>
      new Response(typeof payload === "string" ? payload : JSON.stringify(payload), { status });

    if (url.endsWith("/payment/v1/token")) {
      tokensIssued += 1;
      return json({
        code: "00000",
        token: `MOCK_TOKEN_${tokensIssued}`,
        expirationDate: String(Math.floor(Date.now() / 1000) + 300),
      });
    }
    if (url.endsWith("/payment/v1/merchant/preOrder")) {
      if (behaviour.rejectPreOrder) return json({ code: "10001", msg: "merchant not active" });
      if (behaviour.noPrepayId) return json({ code: "00000", biz_content: {} });
      if (behaviour.unauthorizedOnce && !refused401) {
        refused401 = true;
        return json({ error: "token rejected" }, 401);
      }
      return json({ code: "00000", biz_content: { prepay_id: "MOCK_PREPAY_ID" } });
    }
    if (url.endsWith("/payment/v1/merchant/queryOrder")) {
      if (behaviour.nonJson) return new Response("<html>bad gateway</html>", { status: 200 });
      if (behaviour.serverError) return new Response("upstream exploded", { status: 500 });
      return json({
        code: "00000",
        biz_content: {
          order_status: behaviour.tradeStatus ?? "PAY_SUCCESS",
          total_amount: behaviour.reportedAmount ?? AMOUNT,
          trans_currency: "ETB",
          trans_id: "TB_MOCK_1",
        },
      });
    }
    return json({ code: "99999", msg: `unexpected path ${url}` });
  };

  return { fetchImpl, calls, tokensIssued: () => tokensIssued };
}

const mockConfig = {
  environment: "test",
  baseUrl: `https://${MOCK_HOST}/apiaccess/payment/gateway`,
  webBaseUrl: `https://${MOCK_HOST}/payment/web/paygate?`,
  fabricAppId: "MOCK_FABRIC_APP_ID",
  appSecret: "MOCK_APP_SECRET",
  merchantAppId: "MOCK_MERCHANT_APP_ID",
  merchantCode: "MOCK_MERCHANT_CODE",
  privateKey: exportPem(merchantKeys.privateKey, "pkcs8"),
  publicKey: exportPem(gatewayKeys.publicKey, "spki"),
  notifyUrl: "https://portal.example.et/api/telebirr/notify",
  redirectUrl: "https://portal.example.et/api/telebirr/return",
};

// ---------------------------------------------------------------- real credentials
console.log("\n-- what the portal would do with the credentials it has --");

const saved = {
  PAYMENT_MODE: process.env.PAYMENT_MODE,
  NODE_ENV: process.env.NODE_ENV,
  TELEBIRR_APP_SECRET: process.env.TELEBIRR_APP_SECRET,
};

let credentialsPresent = false;

try {
  if (!Object.keys(process.env).some((name) => name.startsWith("TELEBIRR_"))) {
    console.log("no TELEBIRR_* in this process — the credential checks below can only fail; use npm run check:gateway");
  }
  const config = readTelebirrConfig();
  credentialsPresent = config !== null;
  check(
    "merchant credentials are complete enough to reach the gateway",
    config !== null,
    "readTelebirrConfig() returned null",
  );

  info("payee wallet configured (number not printed)", merchantWallet() ? "yes" : "no");

  if (config) {
    info("gateway environment", config.environment);
    info("api host", new URL(config.baseUrl).host);
    info("checkout host", new URL(config.webBaseUrl).host);

    const probe = {
      timestamp: "1700000000",
      nonce_str: "PROBE",
      method: "payment.preorder",
      version: "1.0",
      biz_content: { merch_order_id: "PROBE", total_amount: "1.00" },
    };
    let signature = "";
    try {
      signature = signRequest(probe, config.privateKey);
    } catch (cause) {
      signature = "";
      info("private key did not load", cause.message);
    }
    check(
      "the pasted merchant key signs an RSA-PSS request the gateway can read",
      Buffer.from(signature, "base64").length === 256,
      `signature bytes=${Buffer.from(signature, "base64").length}`,
    );

    let publicKeyLoads = true;
    try {
      verifySignature(probe, signature, config.publicKey ?? "");
    } catch (cause) {
      publicKeyLoads = false;
      info("gateway public key did not load", cause.message);
    }
    check(
      "an incoming notification can be verified: a gateway key is configured and parses",
      Boolean(config.publicKey) && publicKeyLoads,
      config.publicKey ? "key parses" : "TELEBIRR_PUBLIC_KEY is empty, so every notify is refused",
    );

    const notify = new URL(config.notifyUrl);
    check(
      "the notify URL is somewhere the gateway can actually post to",
      isPublicNotifyUrl(config.notifyUrl),
      `${notify.protocol}//${notify.host} is not public https`,
    );
    check(
      "the notify URL lands on this portal's notify route",
      notify.pathname === "/api/telebirr/notify",
      `pathname=${notify.pathname}`,
    );
    if (config.redirectUrl) {
      let parses = true;
      try {
        new URL(config.redirectUrl);
      } catch {
        parses = false;
      }
      check("the browser return URL is a real URL", parses, config.redirectUrl.slice(0, 60));
    } else {
      info("return URL", "not set — the gateway shows its own result page");
    }

    // Ethio telecom issues the merchant key and the gateway key as two different
    // pairs, so a mismatch here is normal and is reported, not failed.
    info(
      "merchant key and gateway key are the same pair",
      verifySignature(probe, signature, config.publicKey ?? "") ? "yes" : "no (expected: they are issued separately)",
    );
  }

  process.env.PAYMENT_MODE = "telebirr";
  const asTelebirr = resolveMode();
  check(
    "switching PAYMENT_MODE to telebirr yields a working client, not an error",
    "mode" in asTelebirr && asTelebirr.mode === "telebirr" && asTelebirr.client !== null,
    "error" in asTelebirr ? asTelebirr.error : `mode=${asTelebirr.mode}`,
  );

  delete process.env.TELEBIRR_APP_SECRET;
  const withoutSecret = resolveMode();
  check(
    "a half-configured gateway is refused instead of quietly simulated",
    "error" in withoutSecret && withoutSecret.error.includes("TELEBIRR_APP_SECRET"),
    JSON.stringify(withoutSecret),
  );

  process.env.PAYMENT_MODE = "simulate";
  process.env.NODE_ENV = "production";
  const inProduction = resolveMode();
  check(
    "production ignores a simulate request when credentials are present",
    "mode" in inProduction && inProduction.mode === "telebirr",
    JSON.stringify(inProduction),
  );
} finally {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

const now = resolveMode();
info("mode the portal is answering with right now", "mode" in now ? now.mode : `error: ${now.error}`);

// ---------------------------------------------------------------- money envelope
console.log("\n-- the amount that would be charged --");

check("400 birr is sent as 400.00, never as 40000", centsToTelebirrAmount(40000) === "400.00");
check("odd cents survive the trip", centsToTelebirrAmount(12345) === "123.45");
check("the gateway answer is compared in cents", amountEquals(40000, "400.00"));
check("an answer in minor units is refused, not mistaken for the same money", !amountEquals(40000, "40000"));
check("a smaller answer is refused", !amountEquals(40000, "4.00"));
check("no amount at all is refused", !amountEquals(40000, null));
check("a non-numeric amount is refused", !amountEquals(40000, "paid"));

// ---------------------------------------------------------------- protocol legs
console.log("\n-- the gateway conversation, against the mock --");

const merchOrderId = newMerchOrderId();
check("a merchant order id is what the gateway accepts", /^[A-Za-z0-9]+$/.test(merchOrderId), merchOrderId);

const live = mockGateway();
const client = new TelebirrClient(mockConfig, live.fetchImpl);

const order = await client.createOrder({ title: "Lucky house 50 number 7", amount: AMOUNT, merchOrderId });
check("a preOrder comes back with a prepay_id", order.prepayId === "MOCK_PREPAY_ID", JSON.stringify(order));

const tokenCall = live.calls.find((call) => call.url.endsWith("/token"));
const preOrderCall = live.calls.find((call) => call.url.endsWith("/preOrder"));
check(
  "the fabric token is asked for with X-APP-Key and no Authorization",
  tokenCall?.headers["X-APP-Key"] === mockConfig.fabricAppId && !tokenCall?.headers.Authorization,
  JSON.stringify(tokenCall?.headers),
);
check(
  "the preOrder carries the token as Authorization",
  String(preOrderCall?.headers.Authorization).startsWith("MOCK_TOKEN_"),
  String(preOrderCall?.headers.Authorization),
);
check(
  "the order body names the merchant, the notify URL and the trade type",
  preOrderCall?.body.biz_content.appid === mockConfig.merchantAppId &&
    preOrderCall?.body.biz_content.merch_code === mockConfig.merchantCode &&
    preOrderCall?.body.biz_content.notify_url === mockConfig.notifyUrl &&
    preOrderCall?.body.biz_content.trade_type === "Checkout" &&
    preOrderCall?.body.biz_content.trans_currency === "ETB",
  JSON.stringify(preOrderCall?.body.biz_content),
);
check(
  "the amount charged is the decimal string, not the cents integer",
  preOrderCall?.body.biz_content.total_amount === AMOUNT,
  String(preOrderCall?.body.biz_content.total_amount),
);
check(
  "the request is signed and says how",
  typeof preOrderCall?.body.sign === "string" && preOrderCall?.body.sign_type === "SHA256WithRSA",
);
check(
  "the gateway can verify that signature with the merchant public key",
  verifySignature(preOrderCall.body, preOrderCall.body.sign, exportPem(merchantKeys.publicKey, "spki")),
);
check(
  "the title reaches the gateway as plain ASCII",
  /^[\x20-\x7E]+$/.test(preOrderCall.body.biz_content.title),
  preOrderCall.body.biz_content.title,
);

const checkout = new URL(client.buildCheckoutUrl(order.prepayId));
check(
  "the checkout link is the gateway web host with the prepay id signed",
  checkout.host === MOCK_HOST &&
    checkout.searchParams.get("prepay_id") === "MOCK_PREPAY_ID" &&
    checkout.searchParams.get("trade_type") === "Checkout" &&
    Boolean(checkout.searchParams.get("sign")),
  checkout.toString().slice(0, 120),
);
// version and trade_type are appended after the signature, so they are not what
// the client signed: drop them as well, or the canonical strings differ.
const signedCheckoutFields = Object.fromEntries(
  [...checkout.searchParams]
    .filter(([key]) => !["sign", "sign_type", "version", "trade_type"].includes(key))
    .map(([key, value]) => [key, value]),
);
check(
  "the checkout link's signature survives the query string",
  verifySignature(signedCheckoutFields, checkout.searchParams.get("sign"), exportPem(merchantKeys.publicKey, "spki")),
  JSON.stringify(Object.keys(signedCheckoutFields)),
);
info(
  "fields the checkout link sends unsigned",
  [...checkout.searchParams.keys()].filter((key) => !(key in signedCheckoutFields)).join(", "),
);

const status = await client.queryOrder(merchOrderId);
check("a paid answer means paid", status.paid && status.tradeStatus === "PAY_SUCCESS", JSON.stringify(status.raw));
check("the gateway order id is kept as evidence", status.telebirrOrderId === "TB_MOCK_1");
check("the amount is read back as the gateway wrote it", status.amount === AMOUNT, String(status.amount));
check("only one token was issued for three calls", live.tokensIssued() === 1, `tokens=${live.tokensIssued()}`);

const unpaid = await new TelebirrClient(mockConfig, mockGateway({ tradeStatus: "WAIT_PAY" }).fetchImpl).queryOrder(
  merchOrderId,
);
check("an unpaid answer is not paid", !unpaid.paid && unpaid.tradeStatus === "WAIT_PAY");

const wrongAmount = await new TelebirrClient(
  mockConfig,
  mockGateway({ reportedAmount: "1.00" }).fetchImpl,
).queryOrder(merchOrderId);
check(
  "a paid order whose amount does not match is caught before settlement",
  wrongAmount.paid && !amountEquals(40000, wrongAmount.amount),
  `gateway said ${wrongAmount.amount} for a 400.00 order`,
);

const everyHost = new Set(live.calls.map((call) => new URL(call.url).host));
check("nothing in this run left the machine", everyHost.size === 1 && everyHost.has(MOCK_HOST), [...everyHost].join(","));

// ---------------------------------------------------------------- notification
console.log("\n-- what the gateway sends back when money actually moved --");

const notifyBody = {
  merch_order_id: merchOrderId,
  trade_status: "Completed",
  total_amount: AMOUNT,
  trans_id: "TB_MOCK_2",
  timestamp: "1700000000",
  nonce_str: "NOTIFYNONCE",
};
const notifySign = signRequest(notifyBody, exportPem(gatewayKeys.privateKey, "pkcs8"));

check(
  "a notification signed by the gateway is accepted",
  client.verifyNotification({ ...notifyBody, sign: notifySign, sign_type: "SHA256WithRSA" }).signatureValid,
);
check(
  "a notification wrapped as { data: json } is still read",
  client.verifyNotification({ data: JSON.stringify({ ...notifyBody, sign: notifySign }) }).signatureValid,
);
check(
  "a body that is not an object at all is refused rather than settled",
  (() => {
    try {
      client.verifyNotification("not json");
      return false;
    } catch {
      return true;
    }
  })(),
);
check(
  "one birr changed inside the body invalidates it",
  !client.verifyNotification({
    ...notifyBody,
    total_amount: "399.00",
    sign: notifySign,
  }).signatureValid,
);
check("an unsigned notification is not evidence", !client.verifyNotification(notifyBody).signatureValid);

let mangled = null;
for (let attempt = 0; attempt < 400 && !mangled; attempt += 1) {
  const candidate = signRequest(notifyBody, exportPem(gatewayKeys.privateKey, "pkcs8"));
  if (candidate.includes("+")) mangled = candidate;
}
check(
  "a signature whose base64 plus signs became spaces in the query string still verifies",
  !mangled || client.verifyNotification({ ...notifyBody, sign: mangled.replace(/\+/g, " ") }).signatureValid,
  mangled ? "tested with a real plus" : "no plus produced",
);

const keyless = new TelebirrClient({ ...mockConfig, publicKey: null }, mockGateway().fetchImpl);
check(
  "with no gateway key configured, every notification is refused",
  !keyless.verifyNotification({ ...notifyBody, sign: notifySign }).signatureValid,
);
check("the success word differs per leg and both are known", TelebirrClient.notificationSucceeded("Completed") && TelebirrClient.notificationSucceeded("PAY_SUCCESS"));
check("a failed leg is not success", !TelebirrClient.notificationSucceeded("Failed") && !TelebirrClient.notificationSucceeded(null));

// ---------------------------------------------------------------- failure branches
console.log("\n-- when the gateway misbehaves --");

const rejected = await new TelebirrClient(mockConfig, mockGateway({ rejectPreOrder: true }).fetchImpl)
  .createOrder({ title: "Lucky house 50 number 7", amount: AMOUNT, merchOrderId })
  .catch((cause) => cause);
check(
  "a gateway business error surfaces with its code",
  rejected instanceof TelebirrApiError && rejected.code === "10001",
  String(rejected.message ?? rejected),
);

const empty = await new TelebirrClient(mockConfig, mockGateway({ noPrepayId: true }).fetchImpl)
  .createOrder({ title: "Lucky house 50 number 7", amount: AMOUNT, merchOrderId })
  .catch((cause) => cause);
check("a preOrder without a prepay_id is an error, not a blank checkout", empty instanceof TelebirrApiError, String(empty));

const html = await new TelebirrClient(mockConfig, mockGateway({ nonJson: true }).fetchImpl)
  .queryOrder(merchOrderId)
  .catch((cause) => cause);
check("an HTML answer is refused as non-JSON", html instanceof TelebirrApiError && /non-JSON/.test(html.message), String(html));

const fiveHundred = await new TelebirrClient(mockConfig, mockGateway({ serverError: true }).fetchImpl)
  .queryOrder(merchOrderId)
  .catch((cause) => cause);
check("a 500 answer is reported with its status", fiveHundred instanceof TelebirrApiError && fiveHundred.httpStatus === 500, String(fiveHundred));

const offline = await new TelebirrClient(
  mockConfig,
  () => Promise.reject(new Error("unable to verify the first certificate")),
)
  .queryOrder(merchOrderId)
  .catch((cause) => cause);
check(
  "a TLS-chain failure tells the operator about NODE_EXTRA_CA_CERTS instead of disabling verification",
  offline instanceof TelebirrApiError && /NODE_EXTRA_CA_CERTS/.test(offline.message),
  String(offline),
);

const dropped = mockGateway({ unauthorizedOnce: true });
const stubborn = new TelebirrClient(mockConfig, dropped.fetchImpl);
await stubborn.createOrder({ title: "Lucky house 50 number 7", amount: AMOUNT, merchOrderId }).catch(() => {});
const retried = await stubborn.createOrder({ title: "Lucky house 50 number 7", amount: AMOUNT, merchOrderId });
check("a rejected token is dropped and re-applied, not reused", retried.prepayId === "MOCK_PREPAY_ID" && dropped.tokensIssued() === 2, `tokens=${dropped.tokensIssued()}`);

const failed = results.filter((row) => !row.pass);
console.log(`\n${results.length - failed.length}/${results.length} gateway dry-run checks passed`);
console.log("no connection was opened and nothing was written to the database");
if (!credentialsPresent) {
  console.log(
    "verdict: the real-mode code path is proven against the mock; what is missing is the merchant credentials Ethio Telecom issues (the credential checks above turn ok once they are filled in).",
  );
} else if (!failed.length) {
  console.log("verdict: credentials are present and the real-mode path is ready to switch on.");
}
if (failed.length) process.exitCode = 1;
