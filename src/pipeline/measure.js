// The only layer that joins model output (grams, names) to nutrition data, and
// where the house rules live: corrections, anchors, scale confirmation, tare /
// plausibility warnings. Entries are plain objects; every mutator returns a copy.
import { randomUUID } from 'node:crypto';
import { identifyFood } from '../model/spark.js';
import { segmentItems, refineWithPoints } from '../model/sam.js';
import { ModelCallError } from '../model/client.js';
import { getMode } from '../model/mock.js';
import { computeNutrients, rangeMiddle, NUTRIENT_KEYS } from '../nutrition/nutrients.js';
import { hasUsdaKey, searchFoods } from '../nutrition/usda.js';
import { searchFixtures } from '../nutrition/fixtures.js';
import { rankCandidates, nearMissReasons } from '../nutrition/match.js';
import { resolveUpc } from './barcode.js';

export class UnconfirmedScaleReadingError extends Error {
  constructor(msg = 'scale reading is unconfirmed: confirmScale() first') {
    super(msg);
    this.name = 'UnconfirmedScaleReadingError';
  }
}
export class ScaleDecisionPendingError extends Error {
  constructor() {
    super('scale total and photo estimate diverge: resolveScaleDecision() first');
    this.name = 'ScaleDecisionPendingError';
  }
}
export class IncompleteEntryError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'IncompleteEntryError';
  }
}

// ---- unit conversion (explicit, code only) ----
const G_PER = { g: 1, kg: 1000, oz: 28.349523125, lb: 453.59237 };

export function toGrams(value, unit, secondary = null) {
  if (typeof value !== 'number' || !(value > 0)) throw new Error('scale value must be a positive number');
  let grams;
  if (unit === 'lb_oz') {
    if (secondary?.unit !== 'oz' || !(secondary.value >= 0)) throw new Error('lb_oz needs a secondary oz value');
    grams = value * G_PER.lb + secondary.value * G_PER.oz;
  } else if (unit in G_PER) {
    grams = value * G_PER[unit];
  } else {
    throw new Error(`unit "${unit}" cannot be converted to grams; enter grams instead`);
  }
  return Math.round(grams * 10) / 10;
}

const toGramsOrNull = (value, unit) => { try { return toGrams(value, unit); } catch { return null; } };

// ---- food resolution + nutrient pricing ----
// opts (all optional): env, fetchImpl (one injectable transport for the model
// calls and USDA/OFF lookups), cacheDir (USDA cache), barcodes ({itemId: code}).
const sourceOf = (c) => ({ db: c.db, id: c.id, dataType: c.dataType, fetchedAt: c.fetchedAt });

// Database rows for a food name: USDA FDC search live, the fixture table in mock.
async function searchRows(name, opts) {
  if (getMode(opts.env) === 'live' && hasUsdaKey(opts.env)) {
    const hits = await searchFoods(name, { env: opts.env, fetch: opts.fetchImpl, cacheDir: opts.cacheDir });
    return hits.map((h) => ({ db: 'usda-fdc', id: String(h.id), name: h.description, dataType: h.dataType, per100g: h.per100g, fetchedAt: h.fetchedAt }));
  }
  return searchFixtures(name);
}

// A scanned barcode is an exact hit (score 1) from OFF or USDA branded. Open
// Food Facts has no text search locally, so barcode is the only way OFF joins.
async function barcodeRow(code, opts, warnings) {
  try {
    const r = await resolveUpc(code, { env: opts.env, fetch: opts.fetchImpl });
    if (r.status !== 'matched') {
      if (r.status === 'lookup-failed') warnings.push({ code: 'barcode-lookup-failed', message: `Barcode ${code}: ${r.reason}` });
      return null;
    }
    if (!NUTRIENT_KEYS.every((k) => typeof r.per100g[k] === 'number')) return null; // cannot be priced
    const off = r.source === 'off-local';
    const brand = r.product.brands ? ` (${r.product.brands})` : '';
    return { db: off ? 'off' : 'usda-fdc', id: String(r.product.id), name: `${r.product.name}${brand}`, dataType: off ? 'off-product' : 'Branded', per100g: r.per100g, fetchedAt: null, score: 1 };
  } catch (err) {
    warnings.push({ code: 'barcode-lookup-failed', message: `Barcode ${code}: ${err.message}` });
    return null;
  }
}

// Ranks the candidates, makes the top one the nutrient source, and prices it.
// userDecided: the user chose this food, so there is nothing left to flag.
async function applyFood(item, name, opts = {}, { barcode = null, warnings = [], userDecided = false } = {}) {
  const rows = await searchRows(name, opts);
  const row = barcode && (await barcodeRow(barcode, opts, warnings));
  item.matchCandidates = rankCandidates(name, row ? [row, ...rows] : rows);
  const [win] = item.matchCandidates;
  item.per100g = win?.per100g ?? null;
  item.nutrientSource = win ? sourceOf(win) : null;
  if (!('originalNutrientSource' in item.provenance)) item.provenance.originalNutrientSource = item.nutrientSource; // the auto pick, kept for good
  item.nearMissReasons = userDecided ? [] : nearMissReasons(item.matchCandidates, item.food.identificationConfidence);
  item.nearMiss = item.nearMissReasons.length > 0;
  delete item.notComputedInRecordedRun;
  price(item);
}

function price(item) {
  const g = item.portion.grams;
  item.nutrients = item.per100g && g ? computeNutrients(item.per100g, g) : null;
}

function setPortion(item, low, high, source, confidence) {
  item.portion.grams = { low, likely: rangeMiddle(low, high), high };
  item.portion.loggedGrams = item.portion.grams.likely;
  item.portion.source = source;
  item.portion.confidence = confidence;
}

const find = (entry, itemId) => {
  const item = entry.items.find((i) => i.itemId === itemId);
  if (!item) throw new Error(`no item ${itemId}`);
  return item;
};

// ---- build ----
export async function buildEntry(photoRef, opts = {}) {
  const spark = await identifyFood(photoRef, opts);
  const sam = await segmentItems(photoRef, spark.items, opts);
  return entryFromRuns(photoRef, spark, sam, opts);
}

// Joins an already-obtained Spark + SAM result (live, fixture, or a recorded sample run)
// to the nutrition data. buildEntry is the model-calling wrapper around this.
export async function entryFromRuns(photoRef, spark, sam, opts = {}) {
  const warnings = [];
  const brands = spark.context.brandMarks.map((b) => b.text.toLowerCase());

  const items = [];
  for (const s of spark.items) {
    const seg = sam.items.find((x) => x.itemId === s.itemId);
    // Context may raise identification confidence; it never touches grams or nutrients.
    const boost = brands.some((b) => s.name.toLowerCase().includes(b)) ? 0.1 : 0;
    const item = {
      itemId: s.itemId,
      food: {
        name: s.name,
        source: 'spark',
        identificationConfidence: Math.min(1, Math.round((s.confidence + boost) * 100) / 100),
        originalModelName: s.name,
      },
      alternatives: s.alternatives, // Spark's own runners-up; sits beside matchCandidates
      corrected: false,
      portion: { grams: null, loggedGrams: null, source: null, confidence: 'none', mask: seg.maskStatus, photoEstimate: null },
      mask: seg.mask,
      maskReason: seg.maskReason,
      provenance: { modelLikely: s.grams?.likely ?? null, contextBoost: boost },
    };
    if (s.grams) {
      item.portion.photoEstimate = { low: s.grams.low, high: s.grams.high };
      setPortion(item, s.grams.low, s.grams.high, 'photo-estimate', 'low');
    }
    await applyFood(item, s.name, opts, { barcode: opts.barcodes?.[s.itemId], warnings });
    items.push(item);
  }
  return {
    photoRef,
    items,
    context: spark.context,
    scale: null,
    warnings,
    provenance: { calls: [spark.provenance, ...(sam.provenance.calls ?? [sam.provenance])], strippedNutrientFields: spark.provenance.strippedNutrientFields },
  };
}

// A packaged food from its barcode: one item, nutrients from the label data (OFF local, USDA
// branded), grams entered by the user. Returns { status, ... }: 'matched' carries the entry.
export async function entryFromBarcode(code, grams, opts = {}) {
  const r = await resolveUpc(code, { env: opts.env, fetch: opts.fetchImpl, dataDir: opts.dataDir });
  if (r.status !== 'matched') return r;
  if (!NUTRIENT_KEYS.every((k) => typeof r.per100g[k] === 'number')) return { status: 'incomplete', code, product: r.product };
  const off = r.source === 'off-local';
  const brand = r.product.brands ? ` (${r.product.brands})` : '';
  const name = `${r.product.name}${brand}`;
  const nutrientSource = { db: off ? 'off' : 'usda-fdc', id: String(r.product.id), dataType: off ? 'off-product' : 'Branded', fetchedAt: null };
  const out = { status: 'matched', code, product: { ...r.product, displayName: name }, per100g: r.per100g, servingGrams: r.grams };
  if (!(typeof grams === 'number' && grams > 0)) return out;
  const item = {
    itemId: 'b1',
    food: { name, source: 'barcode', identificationConfidence: 'confirmed', originalModelName: null },
    alternatives: [],
    corrected: false,
    portion: { grams: null, loggedGrams: null, source: null, confidence: 'none', mask: 'none', photoEstimate: null },
    mask: null,
    maskReason: 'no_photo',
    per100g: r.per100g,
    nutrientSource,
    matchCandidates: [],
    nearMiss: false,
    nearMissReasons: [],
    provenance: { originalNutrientSource: nutrientSource },
  };
  setPortion(item, grams, grams, 'user-entered', 'high');
  price(item);
  out.entry = {
    photoRef: `barcode:${code}`,
    items: [item],
    context: { container: { type: 'package', confidence: 1 }, brandMarks: [] },
    scale: null,
    warnings: [],
    provenance: { calls: [], strippedNutrientFields: false },
  };
  return out;
}

// ---- recorded runs: nutrients captured with the live run, replayed in mock mode ----
// What a live run produced for each item (candidates, source, per-100g, nutrients), as plain JSON
// for data/samples/<id>/pipeline-nutrients.json.
export function recordedNutrients(entry) {
  return {
    items: Object.fromEntries(entry.items.map((i) => [i.itemId, {
      matchCandidates: i.matchCandidates, per100g: i.per100g, nutrientSource: i.nutrientSource, nutrients: i.nutrients,
      nearMiss: i.nearMiss, nearMissReasons: i.nearMissReasons,
    }])),
  };
}

// Replaces whatever the mock fixtures computed with the recorded run's own numbers. An item the
// recording has no nutrients for is marked, not priced: nothing here is ever made up.
export function replayRecordedNutrients(entry, recorded) {
  const next = structuredClone(entry);
  for (const item of next.items) {
    const r = recorded?.items?.[item.itemId];
    if (r?.nutrients && r.per100g) {
      Object.assign(item, { matchCandidates: r.matchCandidates ?? [], per100g: r.per100g, nutrientSource: r.nutrientSource, nutrients: r.nutrients, nearMiss: r.nearMiss ?? false, nearMissReasons: r.nearMissReasons ?? [] });
    } else {
      Object.assign(item, { matchCandidates: [], per100g: null, nutrientSource: null, nutrients: null, nearMiss: false, nearMissReasons: [], notComputedInRecordedRun: true });
    }
    item.provenance.originalNutrientSource = item.nutrientSource;
  }
  return next;
}

// ---- corrections and anchors ----
export async function applyCorrection(entry, itemId, correctedFoodName, opts = {}) {
  const next = structuredClone(entry);
  const item = find(next, itemId);
  item.food = { ...item.food, name: correctedFoodName, source: 'user-corrected', identificationConfidence: 'confirmed' };
  item.corrected = true;
  await applyFood(item, correctedFoodName, opts, { userDecided: true }); // same portion, new per-100g
  return next;
}

// Picks one of the item's matchCandidates as the nutrient source. Same
// semantics as applyCorrection: the same portion is repriced from the new
// per-100g, the item becomes user-corrected, and the original nutrient source
// stays in provenance. The candidate list itself is untouched, so the user can
// pick again. (entry is the working state, as for every other mutator here.)
export function selectMatchCandidate(entry, itemId, candidateId) {
  const next = structuredClone(entry);
  const item = find(next, itemId);
  const pick = item.matchCandidates?.find((c) => c.candidateId === candidateId);
  if (!pick) throw new Error(`no match candidate ${candidateId} on item ${itemId}`);
  item.food = { ...item.food, name: pick.name, source: 'user-corrected', identificationConfidence: 'confirmed' };
  item.corrected = true;
  item.per100g = pick.per100g;
  item.nutrientSource = sourceOf(pick);
  item.nearMissReasons = [];
  item.nearMiss = false;
  delete item.notComputedInRecordedRun;
  price(item);
  return next;
}

export function applyAnchor(entry, itemId, grams, source) {
  if (!['user-entered', 'scale-confirmed'].includes(source)) throw new Error(`unknown anchor source "${source}"`);
  if (!(typeof grams === 'number' && grams > 0)) throw new Error('anchor grams must be a positive number');
  const next = structuredClone(entry);
  const item = find(next, itemId);
  if (source === 'scale-confirmed') {
    const s = next.scale;
    if (s?.status !== 'confirmed') throw new UnconfirmedScaleReadingError();
    if (s.decision === 'pending') throw new ScaleDecisionPendingError();
    if (s.decision !== 'not-required' && s.decision !== 'use-scale') throw new Error(`scale decision is "${s.decision}"; not applying the scale`);
    if (s.itemIds.length !== 1 || s.itemIds[0] !== itemId || grams !== s.grams) {
      throw new Error('a confirmed scale reading anchors exactly its one covered item at its converted grams; enter grams for the rest');
    }
  }
  setPortion(item, grams, grams, source, 'high'); // overrides the photo estimate (kept in photoEstimate)
  price(item);
  return next;
}

// A confirmed scale total over 2+ items (INTEGRATION.md section 8): split in proportion to each item's
// photo-range middle, source 'scale-distributed', confidence medium. Shares are whole grams, like every
// logged portion (largest remainder), so they add up to the confirmed total rounded to a gram. Same gates as a scale anchor:
// confirmed, and no pending divergence (the user decides that first, nothing is applied meanwhile).
export function applyScaleDistribution(entry) {
  const s = entry.scale;
  if (s?.status !== 'confirmed') throw new UnconfirmedScaleReadingError();
  if (s.decision === 'pending') throw new ScaleDecisionPendingError();
  if (s.decision !== 'not-required' && s.decision !== 'use-scale') throw new Error(`scale decision is "${s.decision}"; not applying the scale`);
  if (s.itemIds.length < 2) throw new Error('distribution needs 2+ items; a single item is anchored instead');
  const next = structuredClone(entry);
  const items = s.itemIds.map((id) => find(next, id));
  const mids = items.map((i) => {
    const est = i.portion.photoEstimate;
    if (!est) throw new Error(`${i.food.name} has no photo estimate to distribute by; enter its grams instead`);
    return rangeMiddle(est.low, est.high);
  });
  const total = Math.round(s.grams);
  const midSum = mids.reduce((a, b) => a + b, 0);
  const exact = mids.map((m) => (total * m) / midSum);
  const shares = exact.map(Math.floor);
  const left = total - shares.reduce((a, b) => a + b, 0);
  exact.map((x, k) => [x - shares[k], k]).sort((a, b) => b[0] - a[0]).slice(0, left).forEach(([, k]) => { shares[k] += 1; });
  items.forEach((item, k) => {
    const g = shares[k];
    setPortion(item, g, g, 'scale-distributed', 'medium'); // photo range stays in photoEstimate
    price(item);
  });
  return next;
}

// ---- tap refinement ----
// A user tap {x, y, label} (normalised 0..1; label 1 include, 0 exclude), or an array of them, on
// an item. The item's earlier taps ride along (item.maskPoints), and SAM gets them all as one point
// prompt. On ANY failure (mock mode, transport error, no mask, undecodable mask) the entry
// comes back with the previous mask untouched plus a 'mask-refine-failed' warning.
export async function refineMask(entry, itemId, tap, opts = {}) {
  const next = structuredClone(entry);
  const item = find(next, itemId);
  const points = [...(item.maskPoints ?? []), ...[tap].flat().map((t) => ({ x: t.x, y: t.y, label: t.label }))];
  next.warnings = next.warnings.filter((w) => w.code !== 'mask-refine-failed' || w.itemId !== itemId);
  const fail = (reason) => {
    next.warnings.push({ code: 'mask-refine-failed', itemId, reason, message: `Could not refine the outline for ${item.food.name}; kept the previous one.` });
    return next;
  };
  try {
    const r = await refineWithPoints(entry.photoRef, { points }, opts);
    next.provenance.calls.push(r.provenance);
    if (r.mask?.maskStatus !== 'decoded') return fail(r.mask ? 'mask_not_decoded' : r.reason);
    item.mask = r.mask;
    item.maskReason = null;
    item.portion.mask = 'decoded';
    item.maskPoints = points;
    return next;
  } catch (err) {
    return fail(err instanceof ModelCallError ? err.kind : 'error');
  }
}

// ---- scale reading gate ----
// Attaches the OCR reading as UNCONFIRMED. While attached it blocks logging
// and cannot be used as an anchor.
export function attachScaleReading(entry, reading) {
  const next = structuredClone(entry);
  next.scale = reading.status === 'unreadable'
    ? { status: 'unreadable', rawText: reading.rawText }
    : { status: 'unconfirmed', rawText: reading.rawText, value: reading.value, unit: reading.unit, secondary: reading.secondary ?? null };
  return next;
}

// The only path that makes a reading usable. edits {value, unit, secondary,
// itemIds} lets the user fix what the OCR got wrong; itemIds defaults to all items.
export function confirmScale(entry, reading, edits = {}) {
  const value = edits.value ?? reading.value;
  const unit = edits.unit ?? reading.unit;
  const secondary = edits.secondary ?? reading.secondary ?? null;
  const grams = toGrams(value, unit, secondary);
  const itemIds = edits.itemIds ?? entry.items.map((i) => i.itemId);

  const next = structuredClone(entry);
  const covered = next.items.filter((i) => itemIds.includes(i.itemId) && i.portion.photoEstimate);
  const lo = covered.reduce((s, i) => s + i.portion.photoEstimate.low, 0);
  const hi = covered.reduce((s, i) => s + i.portion.photoEstimate.high, 0);
  const tareable = ['plate', 'bowl', 'box', 'cup'].includes(next.context.container.type);

  next.warnings = next.warnings.filter((w) => !w.code.startsWith('scale-'));
  let decision = 'not-required';
  if (covered.length) {
    const tareHint = tareable && grams - hi >= 100
      ? `The scale total is ${Math.round(grams - hi)} g over the photo range; if the ${next.context.container.type} was on the scale, tare it or subtract its weight.`
      : null;
    if (grams < 0.75 * lo || grams > 1.33 * hi) {
      decision = 'pending'; // explicit user choice required; never auto-picked
      // The oz/g mix-up is the documented hazard: say so when the other unit would fit the photo.
      const inRange = (g) => g >= 0.75 * lo && g <= 1.33 * hi;
      const otherUnit = unit === 'g' ? toGramsOrNull(value, 'oz') : unit === 'oz' ? toGramsOrNull(value, 'g') : null;
      const reasoning = [
        `The scale reads ${grams} g; the photo range for ${covered.length === 1 ? covered[0].food.name : 'these items'} is ${lo}–${hi} g.`,
        tareHint,
        otherUnit !== null && inRange(otherUnit) ? `Read as ${unit === 'g' ? 'ounces' : 'grams'} instead, ${value} would be ${otherUnit} g, which fits the photo range. Check the unit on the display.` : null,
      ].filter(Boolean);
      next.warnings.push({
        code: 'scale-divergence',
        message: `Scale: ${grams} g. Photo estimate: ${lo}–${hi} g. These diverge more than expected.`,
        tareHint,
        scaleGrams: grams,
        photoRange: { low: lo, high: hi },
        reasoning,
        options: ['use-scale', 'use-photo', 'enter-grams'],
      });
    } else if (tareHint) {
      next.warnings.push({ code: 'scale-tare-check', message: tareHint, tareHint });
    }
  }
  next.scale = {
    status: 'confirmed', rawText: reading.rawText, value, unit, secondary, grams, itemIds,
    edited: value !== reading.value || unit !== reading.unit,
    decision,
  };
  return next;
}

export function resolveScaleDecision(entry, choice) {
  if (entry.scale?.status !== 'confirmed') throw new UnconfirmedScaleReadingError();
  if (!['use-scale', 'use-photo', 'enter-grams'].includes(choice)) throw new Error(`unknown decision "${choice}"`);
  const next = structuredClone(entry);
  next.scale.decision = choice;
  return next;
}

// ---- finalize / log ----
// Refuses (throws) while a scale reading is unconfirmed or its divergence is undecided.
export function logEntry(entry, { now = new Date() } = {}) {
  if (entry.scale?.status === 'unconfirmed') throw new UnconfirmedScaleReadingError();
  if (entry.scale?.decision === 'pending') throw new ScaleDecisionPendingError();
  if (!entry.items.length) throw new IncompleteEntryError('nothing identified: add an item first');
  for (const i of entry.items) {
    if (!i.portion.grams) throw new IncompleteEntryError(`${i.food.name}: needs a portion`);
    if (!i.nutrients) throw new IncompleteEntryError(`${i.food.name}: ${i.notComputedInRecordedRun ? 'not computed in the recorded run' : 'no food-database match'}`);
  }
  return {
    entryId: randomUUID(),
    loggedAt: now.toISOString(),
    items: entry.items.map((i) => ({
      itemId: i.itemId,
      food: { name: i.food.name, source: i.food.source, identificationConfidence: i.food.identificationConfidence, originalModelName: i.food.originalModelName },
      portion: { ...i.portion },
      nutrientSource: i.nutrientSource,
      originalNutrientSource: i.provenance.originalNutrientSource,
      nutrients: i.nutrients,
      logged: Object.fromEntries(Object.entries(i.nutrients).map(([k, v]) => [k, v.likely])),
    })),
    warnings: entry.warnings,
    provenance: entry.provenance,
  };
}
