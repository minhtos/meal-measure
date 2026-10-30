// UPC/barcode resolution: local OFF import first, USDA branded GTIN fallback,
// then an honest 'unmatched'. A miss is a data fact; an HTTP/rate-limit failure
// is 'lookup-failed' and is never reported as a miss.
import { lookupOff } from '../nutrition/off.js';
import { lookupBrandedGtin, NoUsdaKeyError } from '../nutrition/usda.js';
import { computeNutrients } from '../nutrition/nutrients.js';

// Nutrients for `grams` from whichever per-100g fields the record has.
function nutrientsFor(per100g, grams) {
  if (!grams) return null;
  const filled = { protein: 0, carbs: 0, fat: 0, ...per100g };
  const out = computeNutrients(filled, { low: grams, high: grams });
  for (const k of ['protein', 'carbs', 'fat']) if (!(k in per100g)) delete out[k];
  return out;
}

// opts: { grams (package/serving grams when known), dataDir, env, fetch }
export async function resolveUpc(code, opts = {}) {
  let product = await lookupOff(code, opts);
  let source = 'off-local';
  let servingGrams = null;
  if (!product) {
    try {
      product = await lookupBrandedGtin(code, opts);
    } catch (err) {
      // No key configured: the fallback is unavailable, which is not a
      // lookup failure of this barcode — report the honest local miss.
      if (!(err instanceof NoUsdaKeyError)) return { status: 'lookup-failed', code, reason: err.message };
    }
    source = 'usda-branded';
    servingGrams = product?.servingGrams ?? null;
  }
  if (!product) return { status: 'unmatched', code };
  const grams = opts.grams ?? servingGrams;
  return {
    status: 'matched',
    code,
    source,
    product: { id: product.id ?? product.code, name: product.name, brands: product.brands },
    per100g: product.per100g,
    grams: grams ?? null,
    nutrients: nutrientsFor(product.per100g, grams),
  };
}
