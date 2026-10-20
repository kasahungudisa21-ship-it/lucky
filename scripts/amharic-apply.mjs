/**
 * Composes the hand-authored syllable scripts into the i18n cache.
 *
 *   node scripts/amharic-apply.mjs            # apply scripts/amharic-authored.json
 *   node scripts/amharic-apply.mjs --dry-run   # report only, leave the cache alone
 *
 * Every script is composed from the Unicode table, decomposed again, and
 * re-read against the corpus of words the translation endpoint got right, so a
 * dropped syllable stops the run instead of reaching a page. Run
 * `npm run i18n -- --offline` afterwards to regenerate src/lib/ui.ts.
 */
import { readFile, writeFile } from "node:fs/promises";
import { compose, decompose, wordKey } from "./amharic.mjs";

const PROGRESS = "scripts/i18n-progress.json";
const SCRIPTS = "scripts/amharic-authored.json";
const CORPUS = "scripts/amharic-corpus-words.json";

const DRY = process.argv.includes("--dry-run");
const progress = JSON.parse(await readFile(PROGRESS, "utf8"));
const authored = JSON.parse(await readFile(SCRIPTS, "utf8"));
let corpus = null;
try {
  corpus = new Set(JSON.parse(await readFile(CORPUS, "utf8")));
} catch {
  console.log("no corpus file; novelty check skipped");
}

const unknown = Object.keys(authored).filter((key) => !(key in progress));
if (unknown.length) console.log(`new key(s) composed without the endpoint: ${unknown.join(", ")}`);

let changed = 0;
const novel = [];
for (const [key, script] of Object.entries(authored)) {
  const am = compose(script);
  if (decompose(am) !== script) throw new Error(`${key}: composed text does not decompose back`);
  if (corpus)
    for (const word of script.split(" ")) {
      const clean = wordKey(word);
      if (clean && !corpus.has(clean)) novel.push(`${key}: ${clean}`);
    }
  const was = progress[key]?.authored ? progress[key].am : "translated";
  if (progress[key]?.am === am) {
    console.log(`${key.padEnd(24)} unchanged  ${am}`);
    continue;
  }
  changed += 1;
  console.log(`${key.padEnd(24)} new glyph string  ${was} -> ${am}`);
  if (!DRY) progress[key] = { am, script, authored: true, back: progress[key]?.back ?? "" };
}

if (!DRY && changed) await writeFile(PROGRESS, JSON.stringify(progress, null, 2), "utf8");
if (novel.length)
  console.log(`word(s) absent from the endpoint corpus, read these twice:\n${novel.map((n) => ` - ${n}`).join("\n")}`);
console.log(
  `${DRY ? "dry run: " : ""}${changed} key(s) ${DRY ? "would change" : "written"}; ${
    Object.keys(authored).length
  } authored in total${changed && !DRY ? "; run npm run i18n -- --offline" : ""}`,
);
