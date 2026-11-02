/**
 * Generates src/lib/ui.ts from scripts/strings.en.json.
 *
 * Amharic is produced by a translation endpoint instead of typed by hand, and
 * every result is checked: placeholders must survive and the round trip back to
 * English must describe the same sentence. Progress is cached so a rate-limited
 * run can resume where it stopped.
 *
 * Keys carrying `authored: true` in the cache were composed from the syllabary
 * table by scripts/amharic.mjs and read back by a human. The endpoint must not
 * overwrite them, and their round trip is skipped: a machine cannot adjudicate
 * domain vocabulary it already got wrong (ስዕል for "draw" scored fine).
 */
import { readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";

const ENDPOINT = "https://translate.googleapis.com/translate_a/single";
const SOURCE = path.join("scripts", "strings.en.json");
const OUTPUT = path.join("src", "lib", "ui.ts");
const REPORT = path.join("scripts", "i18n-report.json");
const PROGRESS = path.join("scripts", "i18n-progress.json");

const toSentinel = (text) => text.replace(/\{(\d+)\}/g, "#$1#");
const fromSentinel = (text) => text.replace(/#(\d+)#/g, "{$1}");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The endpoint answers node's own fetch with 429 while a browser-shaped client
// is served, so requests go out through curl. The query is percent-encoded here
// rather than handed to curl as `--data-urlencode q=...`, because curl receives
// Windows argv in the console codepage and non-ASCII text arrives as U+FFFD.
function curlJson(url) {
  const body = execFileSync("curl", ["-sS", "-m", "30", "-A", "Mozilla/5.0", url], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  return JSON.parse(body);
}

async function translateGoogle(text, sl, tl) {
  const url = `${ENDPOINT}?client=gtx&sl=${sl}&tl=${tl}&dt=t&q=${encodeURIComponent(text)}`;
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    try {
      const payload = curlJson(url);
      const out = payload?.[0]?.map((segment) => segment?.[0] ?? "").join("");
      if (!out) throw new Error("empty translation");
      if (out.includes("\uFFFD")) throw new Error("lossy response");
      await sleep(900);
      return out;
    } catch (error) {
      if (attempt === 6) throw new Error(`google ${sl}->${tl} failed: ${error.message}`);
      await sleep(attempt * 4000);
    }
  }
  throw new Error("unreachable");
}

// Google rate-limits this network for long stretches, so a second host keeps a
// run going. Its free tier caps out by day and says so inside a 200 response.
async function translateMyMemory(text, sl, tl) {
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${sl}|${tl}`;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const payload = curlJson(url);
      const out = payload?.responseData?.translatedText ?? "";
      if (!out || out.startsWith("MYMEMORY WARNING")) throw new Error(`refused: ${out.slice(0, 60)}`);
      if (out.includes("\uFFFD")) throw new Error("lossy response");
      await sleep(1200);
      return out;
    } catch (error) {
      if (attempt === 4) throw new Error(`mymemory ${sl}->${tl} failed: ${error.message}`);
      await sleep(attempt * 5000);
    }
  }
  throw new Error("unreachable");
}

async function translate(text, sl, tl) {
  const forced = process.argv.find((arg) => arg.startsWith("--provider="))?.slice("--provider=".length);
  const order =
    forced === "mymemory"
      ? [translateMyMemory]
      : forced === "google"
        ? [translateGoogle]
        : [translateGoogle, translateMyMemory];
  let lastError = null;
  for (const provider of order) {
    try {
      return await provider(text, sl, tl);
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`${sl}->${tl} failed for "${text}": ${lastError?.message}`);
}

const source = JSON.parse(await readFile(SOURCE, "utf8"));
const keys = Object.keys(source);

// Anything non-ASCII in the source arrives back mangled, so it is rejected here
// rather than silently poisoning a generated string ("·" became U+FFFD once).
for (const key of keys) {
  const bad = [...source[key]].filter((ch) => ch.codePointAt(0) > 0x7e);
  if (bad.length)
    throw new Error(
      `${key}: strings.en.json must be ASCII-only, found ${bad.map((ch) => ch.codePointAt(0).toString(16)).join(", ")}`,
    );
}

let progress = {};
try {
  progress = JSON.parse(await readFile(PROGRESS, "utf8"));
} catch {
  progress = {};
}

const problems = [];
// A round-trip result of ASCII question marks is what an encoding failure looks
// like: Windows argv converted every syllable curl could not represent.
const lossy = (text) =>
  !text || text.includes("\uFFFD") || (!/[a-z]{2}/i.test(text) && text.includes("?"));

// --offline rebuilds src/lib/ui.ts from the cache without touching the network,
// so a repair of a cached string can ship while the endpoint is rate-limited.
const OFFLINE = process.argv.includes("--offline");

// --only=draws.title,nav.draws discards the cached pair for those keys and
// re-translates them, so one bad sentence can be fixed without a full run.
const onlyArg = process.argv.find((arg) => arg.startsWith("--only="))?.slice("--only=".length);
const ONLY = onlyArg ? new Set(onlyArg.split(",").map((key) => key.trim())) : null;
if (ONLY) {
  const unknown = [...ONLY].filter((key) => !keys.includes(key));
  if (unknown.length) throw new Error(`--only: unknown key(s) ${unknown.join(", ")}`);
  for (const key of ONLY) delete progress[key];
}

for (const key of keys) {
  if (OFFLINE || (ONLY && !ONLY.has(key))) continue;
  if (progress[key]?.authored) continue;
  const english = source[key];
  const entry = { ...(progress[key] ?? {}) };

  if (lossy(entry.am)) entry.am = fromSentinel(await translate(toSentinel(english), "en", "am"));
  if (lossy(entry.back)) entry.back = await translate(entry.am, "am", "en");

  progress[key] = entry;
  await writeFile(PROGRESS, JSON.stringify(progress, null, 2), "utf8");
  console.log(`${key} ok`);
}

// Cached results are re-checked on every run: a placeholder the endpoint
// swallowed renders as a sentence silently missing its data.
for (const key of keys) {
  const expected = (source[key].match(/\{\d+\}/g) ?? []).length;
  const found = (progress[key]?.am?.match(/\{\d+\}/g) ?? []).length;
  if (expected !== found) problems.push(`${key}: placeholder count ${expected} -> ${found}`);
}

// Round-tripping the Amharic back to English and comparing word sets catches
// the mechanical failures (dropped placeholder, mangled encoding, wrong word
// count). It does not catch a plausible-but-wrong domain term: "draw" rendered
// as ስዕል (picture) scores fine, so the copy also needs a reader.
// Low scores are listed for review rather than failed outright, because
// inflection legitimately changes the wording.
const words = (text) =>
  new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, " ")
      .split(" ")
      .filter((word) => word.length > 2),
  );

const overlap = (english, back) => {
  const expected = words(english);
  if (expected.size === 0) return 1;
  const got = words(back);
  let shared = 0;
  for (const word of expected) if (got.has(word)) shared += 1;
  return shared / expected.size;
};

const report = {};
// Authored copy was produced from the syllabary table and read back by a
// person, so the endpoint score does not apply to it and its missing `back`
// field is not a defect.
const authored = (key) => Boolean(progress[key]?.authored);
const machineKeys = keys.filter((key) => !authored(key));

for (const key of keys) {
  const back = progress[key]?.back ?? "";
  report[key] = {
    en: source[key],
    am: progress[key]?.am ?? "",
    source: authored(key) ? "authored" : "translated",
    back,
    score: authored(key) ? null : Number(overlap(source[key], back).toFixed(2)),
  };
}
await writeFile(REPORT, JSON.stringify(report, null, 2), "utf8");

const weak = machineKeys.filter(
  (key) => !lossy(progress[key]?.back) && report[key].score < 0.5,
);
if (weak.length)
  console.log(
    `LOW ROUND-TRIP MATCH (${weak.length} to review):\n${weak
      .map((key) => ` - ${key} ${report[key].score} | ${source[key]} | ${report[key].back}`)
      .join("\n")}`,
  );

const missing = keys.filter((key) => !progress[key]?.am || progress[key].am.includes("\uFFFD"));
if (missing.length) {
  console.log(`INCOMPLETE OR LOSSY: ${missing.join(", ")}`);
  process.exitCode = 1;
}

const unverified = machineKeys.filter((key) => lossy(progress[key]?.back));
if (unverified.length)
  console.log(
    `round-trip unverified for ${unverified.length} translated key(s) (endpoint rate-limited?)`,
  );
console.log(`${keys.filter(authored).length} of ${keys.length} strings are hand-authored`);

const amharic = keys
  .map((key) => `  ${JSON.stringify(key)}: ${JSON.stringify(progress[key]?.am ?? source[key])},`)
  .join("\n");

const english = keys.map((key) => `  ${JSON.stringify(key)}: ${JSON.stringify(source[key])},`).join("\n");

const file = `/* Generated by scripts/gen-i18n.mjs from scripts/strings.en.json. Do not edit by hand. */

export type Lang = "am" | "en";

export const DEFAULT_LANG: Lang = "am";

const AM: Record<string, string> = {
${amharic}
};

/** The English catalog is scripts/strings.en.json itself: it is what the Amharic
 * was translated from, so it is written by a person and needs no pipeline. */
const EN: Record<string, string> = {
${english}
};

const CATALOGS: Record<Lang, Record<string, string>> = { am: AM, en: EN };

export type Tr = (key: string, args?: Array<string | number>) => string;

const fill = (template: string, args: Array<string | number>) =>
  template.replace(/\\{(\\d+)\\}/g, (_, index) => {
    const value = args[Number(index)];
    return value === undefined ? "" : String(value);
  });

/** Binds one language, so a page reads t("key", [args]) exactly as before. A key
 * missing from the chosen catalog falls back to Amharic rather than the raw key:
 * a half-translated page must still be readable. */
export function tr(lang: Lang): Tr {
  const catalog = CATALOGS[lang] ?? AM;
  return (key, args = []) => fill(catalog[key] ?? AM[key] ?? key, args);
}

/** Amharic whatever the screen shows: this is the language the owner alerts and
 * the participant SMS and Telegram messages go out in. */
export const t: Tr = tr("am");

export const hasKey = (key: string) => Object.prototype.hasOwnProperty.call(AM, key);
`;

if (OFFLINE && missing.length) {
  // A missing Amharic string would make the Amharic catalog fall through to the
  // English one, so the generated file is not written.
  console.log("offline run has lossy/missing strings; ui.ts left untouched");
} else {
  await writeFile(OUTPUT, file, "utf8");
  console.log(`wrote ${OUTPUT}`);
}
console.log(problems.length ? `PROBLEMS:\n - ${problems.join("\n - ")}` : "no placeholder problems detected");
