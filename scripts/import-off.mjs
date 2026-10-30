#!/usr/bin/env node
// One-time bulk import of an Open Food Facts CSV export (tab-separated, header
// row, optionally .gz) into a local US-only lookup:
//   <out>/off-us.jsonl       one compact JSON product per line
//   <out>/off-us.index.json  { code: byteOffset } into the jsonl
// Usage: node scripts/import-off.mjs <products.csv[.gz]> [outDir=data]
// This is the ONLY place OFF data enters the project; there is no per-scan query.
import { createReadStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import { pathToFileURL } from 'node:url';

const num = (v) => {
  if (v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

// Turn one parsed CSV row into a product, or null if it is not a usable US row.
export function toProduct(row) {
  const code = (row.code ?? '').trim();
  if (!/^\d{6,14}$/.test(code)) return null;
  if (!(row.countries_tags ?? '').split(',').includes('en:united-states')) return null;
  const name = (row.product_name ?? '').trim();
  if (!name) return null;
  let kcal = num(row['energy-kcal_100g']);
  if (kcal === null) {
    const kj = num(row.energy_100g);
    if (kj !== null) kcal = Math.round((kj / 4.184) * 10) / 10;
  }
  if (kcal === null) return null;
  const per100g = { kcal };
  for (const [key, col] of [['protein', 'proteins_100g'], ['carbs', 'carbohydrates_100g'], ['fat', 'fat_100g'], ['sugars', 'sugars_100g'], ['sodium', 'sodium_100g']]) {
    const v = num(row[col]);
    if (v !== null) per100g[key] = v; // sodium is grams per 100 g, as in OFF
  }
  return { code, name, brands: (row.brands ?? '').trim(), per100g };
}

export async function importOff(input, outDir = 'data') {
  await mkdir(outDir, { recursive: true });
  const jsonlPath = `${outDir}/off-us.jsonl`;
  const out = createWriteStream(jsonlPath);
  let src = createReadStream(input);
  if (input.endsWith('.gz')) src = src.pipe(createGunzip());
  const lines = createInterface({ input: src, crlfDelay: Infinity });

  const index = {};
  let header = null;
  let offset = 0;
  let rows = 0;
  let kept = 0;
  for await (const line of lines) {
    if (!header) {
      header = line.split('\t');
      continue;
    }
    rows++;
    if (rows % 200000 === 0) process.stderr.write(`import-off: ${rows} rows, ${kept} US products kept\n`);
    const cells = line.split('\t');
    const row = {};
    for (let i = 0; i < header.length; i++) row[header[i]] = cells[i];
    const p = toProduct(row);
    if (!p || p.code in index) continue;
    const text = `${JSON.stringify(p)}\n`;
    index[p.code] = offset;
    offset += Buffer.byteLength(text);
    kept++;
    if (!out.write(text)) await once(out, 'drain');
  }
  out.end();
  await once(out, 'finish');
  await writeFile(`${outDir}/off-us.index.json`, JSON.stringify(index));
  process.stderr.write(`import-off: done — ${rows} rows read, ${kept} US products written to ${outDir}\n`);
  return { rows, kept };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [input, outDir] = process.argv.slice(2);
  if (!input) {
    console.error('usage: node scripts/import-off.mjs <products.csv[.gz]> [outDir=data]');
    process.exit(2);
  }
  await importOff(input, outDir);
}
