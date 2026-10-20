/**
 * Rewrites vocabulary across the cached translations without re-translating.
 *
 * The endpoint's Amharic sentences are mostly grammatical but pick the wrong
 * noun for this product (ስዕል, a picture, for a lottery draw). Asking the
 * endpoint again only risks a different coin flip, so the cached text is
 * decomposed into syllable tokens, the token sequences are replaced, and the
 * result is recomposed from the same Unicode table the composer uses.
 *
 *   node scripts/amharic-reterm.mjs --dump    # key -> token script, for grepping
 *   node scripts/amharic-reterm.mjs --apply   # apply scripts/amharic-reterms.json
 *
 * Everything stays ASCII in argv and in the rules file, because Windows argv
 * converts non-ASCII to U+FFFD before node sees it.
 */
import { readFile, writeFile } from "node:fs/promises";
import { compose, decompose, wordKey } from "./amharic.mjs";

const PROGRESS = "scripts/i18n-progress.json";
const SCRIPTS = "scripts/amharic-scripts.json";
const RULES = "scripts/amharic-reterms.json";

const progress = JSON.parse(await readFile(PROGRESS, "utf8"));
const keys = Object.keys(progress);

// Rules are written as scripts, so "lo-ta-ri ma-saa-le" matches across a word
// boundary too. Syllables never contain the sentinel, so it is safe to flatten.
const SEP = "@space@";

function flatten(script) {
  return script.split(" ").flatMap((word, i) => (i === 0 ? word.split("-") : [SEP, ...word.split("-")]));
}
function unflatten(tokens) {
  const words = [[]];
  for (const token of tokens) {
    if (token === SEP) words.push([]);
    else words[words.length - 1].push(token);
  }
  return words.map((word) => word.join("-")).join(" ");
}

// Token sequences only ever match whole syllables, so a replacement cannot
// splice into the middle of a word and leave a non-word behind.
function replace(tokens, source, target) {
  const out = [];
  let hits = 0;
  for (let i = 0; i < tokens.length; i += 1) {
    const match =
      source.length <= tokens.length - i && source.every((token, j) => tokens[i + j] === token);
    if (match) {
      hits += 1;
      out.push(...target);
      i += source.length - 1;
    } else out.push(tokens[i]);
  }
  return { tokens: out, hits };
}

const mode = process.argv[2] ?? "--dump";

if (mode === "--corpus") {
  // The words the endpoint got right, harvested before anything is rewritten:
  // new copy is checked against this list instead of judged by eye.
  const authored = new Set(
    Object.keys(JSON.parse(await readFile("scripts/amharic-authored.json", "utf8"))),
  );
  const words = new Set();
  for (const key of keys) {
    if (authored.has(key) || progress[key].authored) continue;
    let script;
    try {
      script = decompose(progress[key].am);
    } catch {
      continue;
    }
    for (const word of script.split(" ")) {
      const clean = wordKey(word);
      if (clean) words.add(clean);
    }
  }
  await writeFile(
    "scripts/amharic-corpus-words.json",
    JSON.stringify([...words].sort(), null, 2),
    "utf8",
  );
  console.log(`corpus: ${words.size} word(s) -> scripts/amharic-corpus-words.json`);
} else if (mode === "--dump") {
  const scripts = {};
  let failed = 0;
  for (const key of keys) {
    try {
      scripts[key] = decompose(progress[key].am);
    } catch (error) {
      failed += 1;
      scripts[key] = `!unrecoverable! ${error.message}`;
    }
  }
  await writeFile(SCRIPTS, JSON.stringify(scripts, null, 2), "utf8");
  console.log(`dumped ${keys.length} script(s), ${failed} not decomposable -> ${SCRIPTS}`);
} else if (mode === "--apply") {
  const rules = JSON.parse(await readFile(RULES, "utf8"));
  const compiled = Object.entries(rules).map(([from, to]) => [flatten(from), flatten(to)]);
  let changed = 0;
  let total = 0;
  const skipped = [];
  for (const key of keys) {
    if (progress[key].authored) continue;
    let script;
    try {
      script = decompose(progress[key].am);
    } catch {
      skipped.push(key);
      continue;
    }
    let tokens = flatten(script);
    let hit = false;
    for (const [source, target] of compiled) {
      const result = replace(tokens, source, target);
      tokens = result.tokens;
      if (result.hits) {
        hit = true;
        total += result.hits;
      }
    }
    if (!hit) continue;
    const next = unflatten(tokens);
    const am = compose(next);
    if (decompose(am) !== next) throw new Error(`${key}: recompose drifted`);
    progress[key] = { am, script: next, authored: true, back: progress[key].back };
    changed += 1;
    console.log(`${key}\n  was ${script}\n  now ${next}\n  rendered ${am}`);
  }
  await writeFile(PROGRESS, JSON.stringify(progress, null, 2), "utf8");
  console.log(`re-termed ${changed} key(s), ${total} replacement(s)`);
  if (skipped.length)
    console.log(`not decomposable, author these instead:\n${skipped.map((k) => ` - ${k}`).join("\n")}`);
} else {
  console.log("usage: node scripts/amharic-reterm.mjs --dump | --apply");
}
