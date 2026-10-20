/**
 * Composes Amharic from an ASCII syllable script, so product copy can be written
 * without typing Ethiopic by hand (a hand-typed syllable drops silently).
 *
 * Script grammar: syllables join with "-", words with " ", punctuation is a token.
 * Tokens are the UnicodeData syllable names with the vowel order kept explicit
 * ("laa" = ላ, the 4th order; "la" = ለ, the 1st order — different words), so the
 * input says exactly which glyph is wanted and the output reads back off the
 * same table.
 *
 * Unicode names the Amharic vowel orders by consonant-first spellings, so the
 * sound has to be shifted once: 1st "la" sounds like "ለ = lä", 4th "laa" is the
 * plain "ላ = la", 5th "lee" is "ሌ = lē", 6th "le" is the closing "ል = lə".
 * Picking the order wrong changes the word, which is why --render output is
 * always read back rather than trusted.
 *
 *   node scripts/amharic.mjs --check          # round-trip every token
 *   node scripts/amharic.mjs --render "she-le-maa-ti"
 *   node scripts/amharic.mjs --apply scripts/amharic-authored.json
 *
 * --apply splices results into scripts/i18n-progress.json, which
 * `node scripts/gen-i18n.mjs --offline` then turns into src/lib/ui.ts.
 */
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const { syllables: RAW, aux } = JSON.parse(await readFile("scripts/ethiopic-syllables.json", "utf8"));

// "glottal e" and "pharyngeal a" would collide with the word separator
const TABLE = new Map(Object.entries(RAW).map(([name, cp]) => [name.replace(/ /g, "_"), cp]));
const REVERSE = new Map([...TABLE].map(([token, cp]) => [cp, token]));
for (const [name, cp] of Object.entries(aux)) {
  TABLE.set(name, cp);
  REVERSE.set(cp, name);
}

const PLACEHOLDER = /^\{\d+\}$/;
// no letters: a mistyped syllable has to fail loudly instead of rendering as Latin
const ASCII_RUN = /^[0-9{}.,:;!/?#&_=|<>@$'*·()\[\]+]+$/;
// A hyphen joins syllables inside a word, so a hyphen that is part of the text
// (በራስ-ሰር) travels as its own token instead of being mistaken for a separator.
TABLE.set("hyphen", 0x2d);
REVERSE.set(0x2d, "hyphen");

export function compose(script) {
  const words = [];
  for (const chunk of script.split(" ")) {
    if (chunk === "") continue;
    const letters = [];
    for (const token of chunk.split("-")) {
      if (PLACEHOLDER.test(token)) letters.push(token);
      else if (ASCII_RUN.test(token) && !TABLE.has(token)) letters.push(token);
      else {
        const cp = TABLE.get(token);
        if (cp === undefined) throw new Error(`unknown token "${token}" in "${script}"`);
        letters.push(String.fromCodePoint(cp));
      }
    }
    words.push(letters.join(""));
  }
  return words.join(" ");
}

// A word compared against the corpus drops its punctuation and placeholders, so
// "ነው።" and "ነው" are the same word for the novelty check.
const AUX_NAMES = new Set([...Object.keys(aux), "hyphen"]);
export const wordKey = (word) =>
  word
    .split("-")
    .filter((token) => !AUX_NAMES.has(token) && !PLACEHOLDER.test(token))
    .join("-");

export function decompose(text) {  const words = [];
  let current = null;
  let ascii = "";

  const flushAscii = () => {
    if (!ascii) return;
    current = current === null ? ascii : `${current}-${ascii}`;
    ascii = "";
  };
  const flushWord = () => {
    flushAscii();
    if (current !== null) words.push(current);
    current = null;
  };

  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp === aux.space || ch === " ") {
      flushWord();
      continue;
    }
    const token = REVERSE.get(cp);
    if (token !== undefined) {
      flushAscii();
      current = current === null ? token : `${current}-${token}`;
      continue;
    }
    if (cp < 0x1200) {
      if (!ASCII_RUN.test(ch)) throw new Error(`unexpected character U+${cp.toString(16)} ("${ch}")`);
      ascii += ch;
      continue;
    }
    flushAscii();
    throw new Error(`no token for U+${cp.toString(16)} ("${ch}")`);
  }
  flushWord();
  return words.join(" ");
}

// independently established codepoints: scripts/brand.ts carries the brand name
// as escapes that were verified against the original demo page
const ANCHORS = [["laa-ki", "\u120B\u12AA", "brand name"]];

function selfTest() {
  let failures = 0;

  for (const [script, expected, label] of ANCHORS) {
    const got = compose(script);
    if (got !== expected) {
      failures += 1;
      console.log(`FAIL anchor ${script} (${label}): got ${[...got].map((c) => c.codePointAt(0).toString(16)).join(" ")}`);
    }
  }

  const tokens = [...TABLE.keys()];
  for (const token of tokens) {
    // a leading or trailing "space"/"wordspace" is not recoverable from the
    // rendered text, so keep every test token inside a word
    if (token === "space" || token === "wordspace") continue;
    const script = `${token} ki-${token}`;
    const back = decompose(compose(script));
    if (back !== script) {
      failures += 1;
      console.log(`FAIL round trip ${script} -> ${back}`);
    }
  }
  for (const script of [
    "ya-pharyngeal_e-thaa maa-we-chaa",
    "she-le-maa-ti {0} be-re",
    "qu-the-re we-dee-to-chi",
    "ba-raa-se-hyphen-sa-re",
  ]) {
    const back = decompose(compose(script));
    if (back !== script) {
      failures += 1;
      console.log(`FAIL phrase ${script} -> ${back}`);
    }
  }

  console.log(
    failures
      ? `${failures} failure(s)`
      : `all ${tokens.length} syllables, the brand anchor and the sample phrases round-trip`,
  );
  return failures === 0;
}

async function main() {
  const arg = (flag) => process.argv.find((a) => a.startsWith(`${flag}=`))?.slice(flag.length + 1);

  if (process.argv.includes("--check")) {
    process.exitCode = selfTest() ? 0 : 1;
  } else if (process.argv.includes("--render")) {
    const script = process.argv[process.argv.indexOf("--render") + 1] ?? "";
    const text = compose(script);
    console.log(text);
    console.log(`codepoints: ${[...text].map((c) => c.codePointAt(0).toString(16)).join(" ")}`);
  } else if (process.argv.includes("--decompose")) {
    console.log(decompose(process.argv[process.argv.indexOf("--decompose") + 1] ?? ""));
  } else if (arg("--render-file")) {
    const scripts = JSON.parse(await readFile(arg("--render-file"), "utf8"));
    // Reading Ethiopic back is unreliable, so a rendered word that has never
    // appeared in the machine-corrected corpus is flagged for a second look
    // instead of being judged by eye.
    let corpus = null;
    try {
      corpus = new Set(JSON.parse(await readFile("scripts/amharic-corpus-words.json", "utf8")));
    } catch {
      corpus = null;
    }
    for (const [key, script] of Object.entries(scripts)) {
      const text = compose(script);
      const back = decompose(text);
      const novel =
        corpus === null
          ? []
          : script
              .split(" ")
              .map(wordKey)
              .filter((word) => word && !corpus.has(word));
      const flag = back === script ? (novel.length ? "new" : "ok ") : "RT!";
      console.log(`${flag} ${key.padEnd(20)} ${text}`);
      if (back !== script) console.log(`     script drifted: ${back}`);
      if (novel.length) console.log(`     not in corpus: ${novel.join(" ")}`);
    }
  } else if (arg("--apply")) {
    const authored = JSON.parse(await readFile(arg("--apply"), "utf8"));
    const progress = JSON.parse(await readFile("scripts/i18n-progress.json", "utf8"));
    let n = 0;
    for (const [key, script] of Object.entries(authored)) {
      const am = compose(script);
      if (am.includes("\uFFFD")) throw new Error(`${key}: composed string contains U+FFFD`);
      const expectedPh = (script.match(/\{\d+\}/g) ?? []).length;
      const gotPh = (am.match(/\{\d+\}/g) ?? []).length;
      if (expectedPh !== gotPh) throw new Error(`${key}: placeholders ${expectedPh} -> ${gotPh}`);
      progress[key] = { am, script, authored: true };
      n += 1;
    }
    await writeFile("scripts/i18n-progress.json", JSON.stringify(progress, null, 2), "utf8");
    console.log(
      `authored ${n} string(s) into scripts/i18n-progress.json; run node scripts/gen-i18n.mjs --offline`,
    );
  } else {
    console.log(
      "usage: node scripts/amharic.mjs --check | --render <script> | --decompose <text> | --apply=<file.json>",
    );
  }
}

// importing compose/decompose from another script must not run the CLI
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
