#!/usr/bin/env node
// Usage: node scripts/test-upcs.mjs <upc...>
// Runs resolveUpc against the real imported data in data/. The USDA fallback
// needs USDA_API_KEY in env (e.g. node --env-file=$HOME/.config/usda-api.env ...).
import { resolveUpc } from '../src/pipeline/barcode.js';

const codes = process.argv.slice(2);
if (!codes.length) {
  console.error('usage: node scripts/test-upcs.mjs <upc...>');
  process.exit(2);
}
for (const code of codes) {
  const r = await resolveUpc(code);
  if (r.status === 'matched') console.log(`${code}\tmatched\t${r.product.name}\t${r.source}\t${r.per100g.kcal} kcal/100g`);
  else console.log(`${code}\t${r.status}\t-\t-\t${r.reason ?? '-'}`);
}
