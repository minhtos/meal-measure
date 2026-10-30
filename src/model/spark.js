// Contract A — Spark photo food identification. The model identifies and
// estimates grams; it never supplies nutrients. Any nutrient-like field in a
// response is dropped here and flagged in provenance.
import { getMode, loadFixture, mockProvenance } from './mock.js';
import { loadPhoto, sparkChat, provenanceOf, ModelCallError } from './client.js';

const NUTRIENT_KEY = /calor|kcal|energy|protein|fat|carb|sugar|fib(er|re)|sodium|nutrient|macro|cholesterol|vitamin/i;
const ITEM_KEYS = ['itemId', 'regionId', 'name', 'preparation', 'alternatives', 'grams', 'confidence', 'bbox'];
const MAX_GRAMS = 3000;
const CONTAINERS = new Set(['plate', 'bowl', 'box', 'cup', 'wrapper', 'none']);

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const conf = (v) => (num(v) !== null && v >= 0 && v <= 1 ? v : 0);

function cleanGrams(g) {
  if (!g) return null;
  const { low, likely, high } = g;
  const ok = [low, likely, high].every((v) => num(v) !== null) && low > 0 && low <= likely && likely <= high && high <= MAX_GRAMS;
  return ok ? { low, likely, high } : null;
}

// Whitelist-copy known keys (unknown keys dropped); report whether a dropped
// key looked like a nutrient so provenance can say so.
function cleanItem(raw, index, state) {
  if (Object.keys(raw).some((k) => !ITEM_KEYS.includes(k) && NUTRIENT_KEY.test(k))) state.stripped = true;
  if (typeof raw.name !== 'string' || !raw.name.trim()) return null;
  return {
    itemId: typeof raw.itemId === 'string' ? raw.itemId : `i${index + 1}`,
    regionId: typeof raw.regionId === 'string' ? raw.regionId : null,
    name: raw.name.trim(),
    preparation: typeof raw.preparation === 'string' ? raw.preparation : null,
    alternatives: (Array.isArray(raw.alternatives) ? raw.alternatives : [])
      .filter((a) => typeof a?.name === 'string')
      .slice(0, 5)
      .map((a) => ({ name: a.name, confidence: conf(a.confidence) })),
    grams: cleanGrams(raw.grams), // null => pipeline treats the item as needs_portion
    confidence: conf(raw.confidence),
    bbox: Array.isArray(raw.bbox) && raw.bbox.length === 4 ? raw.bbox.map(Number) : null,
  };
}

function cleanContext(raw = {}) {
  const container = raw.container && CONTAINERS.has(raw.container.type)
    ? { type: raw.container.type, confidence: conf(raw.container.confidence) }
    : { type: 'none', confidence: 0 };
  const sign = (s) => (s && typeof s.text === 'string' ? { text: s.text, confidence: conf(s.confidence) } : null);
  return {
    container,
    brandMarks: (Array.isArray(raw.brandMarks) ? raw.brandMarks : []).map(sign).filter(Boolean),
    placeHint: sign(raw.placeHint),
    scaleVisible: raw.scaleVisible === true,
  };
}

// Required verbatim in every identification prompt (benchmark: a visible oz
// readout misread as grams swung an estimate by 515 g).
export const SCALE_IGNORE_RULE = 'Ignore any scale display or numeric readout visible in the photo. Do not use displayed numbers when estimating grams.';

export const IDENTIFY_PROMPT = `You identify foods in a meal photo and estimate how many grams of each are visible.
${SCALE_IGNORE_RULE}
Do not return calories, macronutrients, or any nutrient values.
Reply with JSON only, no prose, in this shape:
{"items":[{"name":"cooked white rice","preparation":"boiled or null","alternatives":[{"name":"jasmine rice, cooked","confidence":0.2}],"grams":{"low":120,"likely":160,"high":210},"confidence":0.7,"bbox":[x,y,w,h as 0-1 fractions of the image]}],
"context":{"container":{"type":"plate|bowl|box|cup|wrapper|none","confidence":0.8},"brandMarks":[{"text":"","confidence":0}],"placeHint":{"text":"","confidence":0},"scaleVisible":false}}`;

export function parseJsonReply(text) {
  const body = text.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  try {
    return JSON.parse(body);
  } catch {
    const m = body.match(/\{[\s\S]*\}/);
    if (!m) throw new ModelCallError('schema', 'reply is not JSON');
    try { return JSON.parse(m[0]); } catch { throw new ModelCallError('schema', 'reply is not valid JSON'); }
  }
}

function shape(raw, provenance) {
  const state = { stripped: Object.keys(raw).some((k) => !['items', 'context'].includes(k) && NUTRIENT_KEY.test(k)) };
  const items = (Array.isArray(raw.items) ? raw.items : []).map((it, i) => cleanItem(it, i, state)).filter(Boolean);
  return { items, context: cleanContext(raw.context), provenance: { ...provenance, strippedNutrientFields: state.stripped } };
}

async function identifyLive(photoRef, opts) {
  const photo = loadPhoto(photoRef); // live: photoRef is a JPEG file path
  try {
    let reply;
    for (let attempt = 0; ; attempt++) { // one retry on schema failure, same input
      reply = await sparkChat(IDENTIFY_PROMPT, photo, opts);
      try {
        return shape(parseJsonReply(reply.text), provenanceOf('spark.identify', photo, reply));
      } catch (err) {
        if (!(err instanceof ModelCallError) || attempt === 1) throw err;
      }
    }
  } catch (err) {
    if (!(err instanceof ModelCallError)) throw err;
    // Pipeline falls back to the manual path: user names items.
    return shape({}, { call: 'spark.identify', mode: 'live', inputSha256: photo.sha256, at: new Date().toISOString(), error: { kind: err.kind, message: err.message, retryable: err.retryable } });
  }
}

export async function identifyFood(photoRef, opts = {}) {
  if (getMode(opts.env) === 'live') return identifyLive(photoRef, opts);
  const fx = loadFixture('spark.json', photoRef);
  return shape(fx?.data ?? { items: [], context: {} },
    mockProvenance('spark.identify', fx?.label ?? 'FIXTURE — no recording for this photo; empty result'));
}
