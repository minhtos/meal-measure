// Local Open Food Facts lookup over the US-filtered import (scripts/import-off.mjs).
// Reads one line by byte offset; never loads the jsonl and never touches the network.
import { open, readFile } from 'node:fs/promises';

const DEFAULT_DIR = new URL('../../data/', import.meta.url).pathname;
const indexes = new Map(); // dir -> parsed index (small: code -> offset)

async function loadIndex(dir) {
  if (!indexes.has(dir)) indexes.set(dir, JSON.parse(await readFile(`${dir}/off-us.index.json`, 'utf8')));
  return indexes.get(dir);
}

// UPC-A (12), EAN-13 and GTIN-14 are the same number with leading zeros.
export function codeVariants(code) {
  const raw = String(code).trim();
  if (!/^\d+$/.test(raw)) return [];
  const stripped = raw.replace(/^0+/, '');
  const out = new Set([raw, stripped]);
  for (const len of [12, 13, 14]) if (stripped.length <= len) out.add(stripped.padStart(len, '0'));
  return [...out];
}

// Returns the product, or null for a genuine miss. A missing import (no data
// dir) is a setup error and throws; a barcode that isn't in it is just null.
export async function lookupOff(code, opts = {}) {
  const dir = opts.dataDir ?? DEFAULT_DIR;
  const index = await loadIndex(dir);
  const hit = codeVariants(code).find((c) => Object.hasOwn(index, c));
  if (!hit) return null;
  const fh = await open(`${dir}/off-us.jsonl`, 'r');
  try {
    // Products are small; 64 KiB comfortably covers one line.
    const buf = Buffer.alloc(65536);
    const { bytesRead } = await fh.read(buf, 0, buf.length, index[hit]);
    const text = buf.toString('utf8', 0, bytesRead);
    return JSON.parse(text.slice(0, text.indexOf('\n')));
  } finally {
    await fh.close();
  }
}
