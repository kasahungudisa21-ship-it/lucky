/**
 * Extracts the already-verified Ethiopic brand tokens from the existing LUCKY
 * demo and re-emits them as \u escapes, so no glyph is re-typed by hand.
 *
 * Only the logo and the name come from the demo: its own <title> and eyebrow
 * advertise a house-rental service, so every product sentence is authored in
 * scripts/amharic-authored.json instead.
 */
import { readFile, writeFile } from "node:fs/promises";

const DEMO = "C:/Users/kasahun/Documents/Qoder/2026-10-17/bbe5f2ba/lucky-demo.html";
const OUTPUT = "src/lib/brand.ts";

const escape = (text) =>
  `"${[...text]
    .map((char) => {
      const code = char.codePointAt(0);
      return code > 127 ? `\\u{${code.toString(16).toUpperCase()}}` : char;
    })
    .join("")}"`;

const source = await readFile(DEMO, "utf8");

const logo = source.match(/class="logo">([^<]+)<\/span>/)?.[1];
const brand = source.match(/<\/span>([^<]+?)\s*<span class="brand__en">/)?.[1];

if (!logo || !brand) {
  console.error("could not locate the brand tokens in the demo file");
  process.exit(1);
}

const file = `/* The brand glyph and name, lifted verbatim from the verified lucky-demo.html. */

export const BRAND_LOGO = ${escape(logo)};
export const BRAND_NAME = ${escape(brand)};
export const BRAND_EN = "LUCKY";
`;

await writeFile(OUTPUT, file, "utf8");
console.log(`wrote ${OUTPUT}`);
console.log(`logo cp: ${[...logo].map((c) => c.codePointAt(0).toString(16)).join(" ")}`);
console.log(`brand cp: ${[...brand].map((c) => c.codePointAt(0).toString(16)).join(" ")}`);
