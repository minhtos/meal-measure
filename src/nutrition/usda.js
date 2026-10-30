// USDA FoodData Central search client. The key comes from process.env only and
// is sent in a header, so it never appears in a URL, cache file, or error.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const BASE = 'https://api.nal.usda.gov/fdc/v1/foods/search';
const CACHE_DIR = new URL('../../.cache/usda/', import.meta.url); // gitignored
// FDC nutrient numbers: 208 energy (kcal), 203 protein, 205 carbohydrate, 204 total fat.
const NUMBERS = { 208: 'kcal', 203: 'protein', 205: 'carbs', 204: 'fat' };

export class NoUsdaKeyError extends Error {
  constructor() {
    super('USDA FoodData Central: no key in env (set USDA_API_KEY)');
    this.name = 'NoUsdaKeyError';
  }
}

export const hasUsdaKey = (env = process.env) => Boolean(env.USDA_API_KEY);

export function per100gFromFood(food) {
  const out = {};
  for (const n of food.foodNutrients ?? []) {
    const key = NUMBERS[Number(n.nutrientNumber)];
    if (key && typeof n.value === 'number') out[key] = n.value;
  }
  return ['kcal', 'protein', 'carbs', 'fat'].every((k) => k in out) ? out : null;
}

export class UsdaHttpError extends Error {
  constructor(status) {
    super(`USDA FoodData Central lookup failed: HTTP ${status}`);
    this.name = 'UsdaHttpError';
    this.status = status;
  }
}

// Branded-food lookup by GTIN/UPC. Fallback for when the local OFF import
// misses. Returns a product ({id, name, brands, per100g, servingGrams,
// fetchedAt}) or null for a genuine miss; HTTP failures (incl. 429) throw
// UsdaHttpError so callers never mistake them for a miss.
export async function lookupBrandedGtin(code, opts = {}) {
  const env = opts.env ?? process.env;
  if (!hasUsdaKey(env)) throw new NoUsdaKeyError();
  const digits = String(code).replace(/^0+/, '');
  const url = `${BASE}?${new URLSearchParams({ query: digits, dataType: 'Branded', pageSize: '10' })}`;
  const res = await (opts.fetch ?? fetch)(url, { headers: { 'X-Api-Key': env.USDA_API_KEY } });
  if (!res.ok) throw new UsdaHttpError(res.status);
  const body = await res.json();
  const food = (body.foods ?? []).find((f) => String(f.gtinUpc ?? '').replace(/^0+/, '') === digits);
  const per100g = food && per100gFromFood(food);
  if (!per100g) return null;
  const grams = food.servingSizeUnit?.toLowerCase() === 'g' && food.servingSize > 0 ? food.servingSize : null;
  return {
    id: food.fdcId,
    name: food.description,
    brands: food.brandOwner ?? '',
    per100g,
    servingGrams: grams,
    fetchedAt: new Date().toISOString(),
  };
}

// opts.fetch lets callers inject a transport; opts.env defaults to process.env.
export async function searchFoods(query, opts = {}) {
  const env = opts.env ?? process.env;
  if (!hasUsdaKey(env)) throw new NoUsdaKeyError();

  const cacheFile = new URL(`${createHash('sha256').update(query.toLowerCase()).digest('hex')}.json`, CACHE_DIR);
  let cached = null;
  try {
    cached = JSON.parse(await readFile(cacheFile, 'utf8'));
  } catch {
    /* cache miss */
  }
  if (!cached) {
    const url = `${BASE}?${new URLSearchParams({ query, pageSize: '5', dataType: 'Foundation,SR Legacy' })}`;
    const res = await (opts.fetch ?? fetch)(url, { headers: { 'X-Api-Key': env.USDA_API_KEY } });
    if (!res.ok) throw new Error(`USDA FoodData Central search failed: HTTP ${res.status}`);
    cached = { fetchedAt: new Date().toISOString(), body: await res.json() };
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(cacheFile, JSON.stringify(cached));
  }
  return (cached.body.foods ?? [])
    .map((f) => ({ id: f.fdcId, description: f.description, dataType: f.dataType, per100g: per100gFromFood(f), fetchedAt: cached.fetchedAt }))
    .filter((f) => f.per100g);
}
