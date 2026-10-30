// Entry -> the JSON the browser gets. Drops raw mask payloads and server paths; masks go out
// as SVG paths (fill-rule evenodd) in image-pixel space, with the box polygon as the fallback.
import { sumNutrients } from './dayLog.js';

const SAFE_PATH = /^[ML\d. Z-]+$/;
const polyPath = (poly) => `M${poly.map(([x, y]) => `${x} ${y}`).join('L')}Z`;

function maskView(mask, status) {
  if (!mask) return null;
  const path = mask.path ?? (mask.polygon?.length ? polyPath(mask.polygon) : null);
  if (!path || !SAFE_PATH.test(path)) return null;
  return { status, path, bbox: mask.bbox ?? null, confidence: mask.confidence ?? null };
}

function itemView(i) {
  return {
    itemId: i.itemId,
    name: i.food.name,
    originalName: i.food.originalModelName,
    foodSource: i.food.source,
    identificationConfidence: i.food.identificationConfidence,
    alternatives: i.alternatives,
    corrected: i.corrected,
    grams: i.portion.grams,
    photoEstimate: i.portion.photoEstimate,
    portionSource: i.portion.source,
    portionConfidence: i.portion.confidence,
    mask: maskView(i.mask, i.portion.mask),
    maskReason: i.maskReason ?? null,
    nutrients: i.nutrients,
    nutrientSource: i.nutrientSource ? { db: i.nutrientSource.db, id: i.nutrientSource.id } : null,
    nearMiss: i.nearMiss ?? false,
    nearMissReasons: i.nearMissReasons ?? [],
    matchCandidates: (i.matchCandidates ?? []).map((c) => ({ candidateId: c.candidateId, name: c.name, db: c.db, dataType: c.dataType, score: c.score })),
  };
}

// meta: { sessionId, mock, mockLabel, photo }
export function entryView(entry, meta) {
  const items = entry.items.map(itemView);
  return {
    ...meta,
    items,
    totals: sumNutrients(items),
    unmatched: items.filter((i) => !i.nutrients).length,
    scale: entry.scale,
    warnings: entry.warnings,
    context: { container: entry.context.container },
    modelErrors: entry.provenance.calls.filter((c) => c.error).map((c) => ({ call: c.call, kind: c.error.kind })),
  };
}
