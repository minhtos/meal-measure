// The only layer that joins model output (grams, names) to nutrition data, and
// where the house rules live: corrections, anchors, scale confirmation, tare /
// plausibility warnings. Entries are plain objects; every mutator returns a copy.
import { randomUUID } from 'node:crypto';
import { identifyFood } from '../model/spark.js';
import { segmentItems } from '../model/sam.js';
import { getMode } from '../model/mock.js';
import { computeNutrients, rangeMiddle } from '../nutrition/nutrients.js';
import { hasUsdaKey, searchFoods } from '../nutrition/usda.js';
import { lookupFixture } from '../nutrition/fixtures.js';

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

// ---- food resolution + nutrient pricing ----
async function resolvePer100g(name) {
  if (getMode() === 'live' && hasUsdaKey()) {
    const [hit] = await searchFoods(name);
    if (!hit) return null;
    return { per100g: hit.per100g, source: { db: 'usda-fdc', id: String(hit.id), dataType: hit.dataType, fetchedAt: hit.fetchedAt } };
  }
  const fx = lookupFixture(name);
  return fx && { per100g: fx.per100g, source: { db: 'fixture', id: fx.id, dataType: 'test-fixture', fetchedAt: null } };
}

async function applyFood(item, name) {
  const match = await resolvePer100g(name);
  item.per100g = match?.per100g ?? null;
  item.nutrientSource = match?.source ?? null;
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
export async function buildEntry(photoRef) {
  const spark = await identifyFood(photoRef);
  const sam = await segmentItems(photoRef, spark.items);
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
        alternatives: s.alternatives,
      },
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
    await applyFood(item, s.name);
    items.push(item);
  }
  return {
    photoRef,
    items,
    context: spark.context,
    scale: null,
    warnings: [],
    provenance: { calls: [spark.provenance, sam.provenance], strippedNutrientFields: spark.provenance.strippedNutrientFields },
  };
}

// ---- corrections and anchors ----
export async function applyCorrection(entry, itemId, correctedFoodName) {
  const next = structuredClone(entry);
  const item = find(next, itemId);
  item.food = { ...item.food, name: correctedFoodName, source: 'user-corrected', identificationConfidence: 'confirmed' };
  item.corrected = true;
  await applyFood(item, correctedFoodName); // same portion, new per-100g
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
      next.warnings.push({
        code: 'scale-divergence',
        message: `Scale: ${grams} g. Photo estimate: ${lo}–${hi} g. These diverge more than expected.`,
        tareHint,
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
    if (!i.nutrients) throw new IncompleteEntryError(`${i.food.name}: no food-database match`);
  }
  return {
    entryId: randomUUID(),
    loggedAt: now.toISOString(),
    items: entry.items.map((i) => ({
      itemId: i.itemId,
      food: { name: i.food.name, source: i.food.source, identificationConfidence: i.food.identificationConfidence, originalModelName: i.food.originalModelName },
      portion: { ...i.portion },
      nutrientSource: i.nutrientSource,
      nutrients: i.nutrients,
      logged: Object.fromEntries(Object.entries(i.nutrients).map(([k, v]) => [k, v.likely])),
    })),
    warnings: entry.warnings,
    provenance: entry.provenance,
  };
}
