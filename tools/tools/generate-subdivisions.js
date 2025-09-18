// Node script to generate /public/geo/<COUNTRY>.json from ISO-3166-2
// Usage: npm i iso-3166-2
//        node tools/generate-subdivisions.js
import fs from "fs";
import path from "path";
import iso3166 from "iso-3166-2";

const ROOT = path.resolve(process.cwd(), "public", "geo");
const countriesPath = path.join(ROOT, "countries.json");

// Ensure /public/geo exists
fs.mkdirSync(ROOT, { recursive: true });

// Load countries list (we already have this file)
const countries = JSON.parse(fs.readFileSync(countriesPath, "utf8"));

let generated = 0, empty = 0;

for (const { code } of countries) {
  const subs = iso3166.subdivision(code);
  const arr = Object.entries(subs || {}).map(([full, meta]) => {
    // full is like "US-CA" → take suffix
    const short = full.includes("-") ? full.split("-")[1] : full;
    return { code: short, name: meta.name };
  });

  const out = path.join(ROOT, `${code}.json`);
  fs.writeFileSync(out, JSON.stringify(arr, null, 2), "utf8");
  if (arr.length) generated++; else empty++;
}

console.log(`Done. Generated: ${generated}, empty: ${empty}, into ${ROOT}`);
