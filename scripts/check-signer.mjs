/**
 * The Telebirr signing path cannot be exercised without merchant credentials, so
 * this checks it against a locally generated RSA keypair instead: canonical
 * ordering, sign/verify round trip, and the base64-repair branches a query-string
 * notification goes through. Run with: npm run check:signer
 */
import { generateKeyPairSync } from "node:crypto";
import { canonicalString, signRequest, verifySignature, nonceStr, SIGN_TYPE } from "../src/lib/telebirr/signer.ts";

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass: Boolean(pass), detail });
  console.log(`${pass ? "ok  " : "FAIL"} ${name}${pass ? "" : ` -- ${detail}`}`);
};

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const pubPem = publicKey.export({ type: "spki", format: "pem" }).toString();
const privBare = Buffer.from(privKeyDer()).toString("base64");
function privKeyDer() {
  return privateKey.export({ type: "pkcs8", format: "der" });
}

const params = {
  app_id: "APP123",
  timestamp: "1700000000",
  nonce_str: nonceStr(),
  sign_type: SIGN_TYPE,
  version: "v1.0",
  biz_content: { amount: "20.00", merch_order_id: "LK1700000000ABC", title: "Lucky house 20 number 7" },
  header: { ignored: "yes" },
};

const canonical = canonicalString(params);
check(
  "biz_content is flattened and header/sign are excluded",
  canonical.includes("amount=20.00") &&
    canonical.includes("merch_order_id=LK1700000000ABC") &&
    !canonical.includes("header") &&
    !canonical.includes("biz_content"),
  canonical,
);

const keysInOrder = [...canonical.matchAll(/([^&=]+)=/g)].map((m) => m[1]);
check(
  "keys are sorted by ASCII order",
  keysInOrder.join() === [...keysInOrder].sort().join(),
  keysInOrder.join(","),
);

const signature = signRequest(params, privPem);
check("signature is base64 and 256 bytes for RSA-2048", Buffer.from(signature, "base64").length === 256);
check("signature verifies against the public key", verifySignature(params, signature, pubPem));

const tampered = { ...params, biz_content: { ...params.biz_content, amount: "100.00" } };
check("a changed amount fails verification", !verifySignature(tampered, signature, pubPem));

// query-string notifications arrive with "+" decoded to " ". RSA-PSS salts are
// random, so re-sign until the base64 really contains a plus and padding;
// otherwise the repair branches below would be asserted against nothing.
let mangled = null;
for (let attempt = 0; attempt < 200 && !mangled; attempt += 1) {
  const candidate = signRequest(params, privPem);
  if (candidate.includes("+") && /=+$/.test(candidate)) mangled = candidate;
}
check("a signature containing base64 punctuation was available to test", Boolean(mangled), "no plus/padding in 200 signatures");

if (mangled) {
  check("verification repairs spaces back to plus signs", verifySignature(params, mangled.replace(/\+/g, " "), pubPem));
  check("verification repairs stripped base64 padding", verifySignature(params, mangled.replace(/=+$/, ""), pubPem));
}

const bareSigned = signRequest(params, privBare);
check(
  "bare base64 DER private key signs and the signature verifies",
  verifySignature(params, bareSigned, pubPem),
);

const barePub = Buffer.from(publicKey.export({ type: "spki", format: "der" })).toString("base64");
check("bare base64 DER public key verifies", verifySignature(params, signature, barePub));

const nonces = new Set([nonceStr(), nonceStr(), nonceStr()]);
check("nonce is 32 chars from the documented alphabet", /^[0-9A-Z]{32}$/.test(nonceStr()));
check("nonces differ", nonces.size === 3);

const failed = results.filter((row) => !row.pass);
console.log(`\n${results.length - failed.length}/${results.length} signer checks passed`);
if (failed.length) process.exitCode = 1;
