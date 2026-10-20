import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const source = JSON.parse(await readFile("scripts/strings.en.json", "utf8"));
const defined = new Set(Object.keys(source));

const files = [];
async function collect(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await collect(full);
    else if (/\.(tsx|ts)$/.test(entry.name) && !full.endsWith(path.join("src", "lib", "ui.ts"))) files.push(full);
  }
}
await collect("src");

const texts = new Map();
for (const file of files) texts.set(file, await readFile(file, "utf8"));

const missing = new Map();
for (const [file, text] of texts) {
  for (const m of text.matchAll(/\bt\(\s*"([^"]+)"/g)) {
    if (!defined.has(m[1])) missing.set(m[1], file);
  }
}

const all = [...texts.values()].join("");
const unused = [...defined].filter((key) => !all.includes(`"${key}"`));

if (missing.size === 0) console.log("every t() key used in components exists in strings.en.json");
for (const [key, file] of missing) console.log("UNDEFINED KEY:", key.padEnd(22), file);
if (unused.length) console.log("unused (harmless):", unused.join(", "));
