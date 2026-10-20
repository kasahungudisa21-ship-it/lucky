import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const css = await readFile("src/app/globals.css", "utf8");
const defined = new Set(css.match(/\.[a-zA-Z][a-zA-Z0-9_-]*/g)?.map((s) => s.slice(1)) ?? []);

const files = [];
async function collect(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await collect(full);
    else if (/\.(tsx|ts)$/.test(entry.name)) files.push(full);
  }
}
await collect("src");

const used = new Map();
for (const file of files) {
  const text = await readFile(file, "utf8");
  for (const m of text.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)) {
    const raw = (m[1] ?? m[2] ?? "").replace(/\$\{[^}]*\}/g, " ");
    for (const cls of raw.split(/\s+/)) {
      if (!cls || cls.startsWith("[")) continue;
      if (!defined.has(cls)) used.set(cls, [...(used.get(cls) ?? []), file]);
    }
  }
}

if (used.size === 0) console.log("every className has a rule in globals.css");
for (const [cls, where] of used) console.log("MISSING RULE:", cls.padEnd(16), [...new Set(where)].join(", "));
