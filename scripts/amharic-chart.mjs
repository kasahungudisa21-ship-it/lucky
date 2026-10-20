import { readFile } from "node:fs/promises";

const { syllables } = JSON.parse(await readFile("scripts/ethiopic-syllables.json", "utf8"));
const SUFFIXES = ["aa", "ee", "i", "u", "e", "o", "wa", "a"];

const rows = new Map();
for (const name of Object.keys(syllables)) {
  const split = SUFFIXES.find((s) => name.length > s.length && name.endsWith(s));
  const base = split ? name.slice(0, -split.length) : name;
  if (!rows.has(base)) rows.set(base, []);
  rows.get(base).push(name);
}

for (const [base, names] of rows)
  console.log(
    base.padEnd(11),
    names
      .sort((a, b) => syllables[a] - syllables[b])
      .map((n) => `${n}=${String.fromCodePoint(syllables[n])}`)
      .join(" "),
  );
