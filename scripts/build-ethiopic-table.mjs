/**
 * Builds scripts/ethiopic-syllables.json from UnicodeData.txt, so Amharic can be
 * composed from an ASCII syllable script instead of typed glyph by glyph.
 *
 *   curl -o ucd.txt https://www.unicode.org/Public/16.0.0/ucd/UnicodeData.txt
 *   node scripts/build-ethiopic-table.mjs ucd.txt
 *
 * Every name in U+1200-U+135A is unique, so the Unicode name ("LAA", "PEE") is a
 * lossless key for a syllable. Keeping the vowel order explicit is the point: the
 * 1st and 4th orders both transliterate as "la" but are different words.
 */
import { readFile, writeFile } from "node:fs/promises";

const [, , source = "ucd.txt"] = process.argv;
const lines = (await readFile(source, "utf8")).split("\n");

const table = {};
for (const line of lines) {
  if (!line.includes(";ETHIOPIC SYLLABLE ")) continue;
  const [hex, name] = line.split(";");
  const cp = Number.parseInt(hex, 16);
  if (cp < 0x1200 || cp > 0x135a) continue;
  const token = name.replace("ETHIOPIC SYLLABLE ", "").toLowerCase();
  if (table[token]) throw new Error(`duplicate syllable name ${token}`);
  table[token] = cp;
}

// punctuation and word space are not syllables but are needed to write a phrase
const AUX = { space: 0x20, wordspace: 0x1361, stop: 0x1362, comma: 0x1363, colon: 0x1365, question: 0x1367 };

await writeFile(
  "scripts/ethiopic-syllables.json",
  JSON.stringify({ generatedFrom: "UnicodeData.txt 16.0.0", syllables: table, aux: AUX }, null, 2) + "\n",
  "utf8",
);
console.log(`wrote scripts/ethiopic-syllables.json with ${Object.keys(table).length} syllables`);
