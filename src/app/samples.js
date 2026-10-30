// Recorded sample runs (data/samples/<id>/) replayed for mock mode. The recordings hold raw
// SAM mask payloads; they are decoded here with the same codec path as a live response, so
// the mock surface exercises the real mask -> SVG path code.
import { readFileSync, existsSync } from 'node:fs';
import { segmentToMask } from '../model/sam.js';
import { loadPhoto } from '../model/client.js';

const ROOT = new URL('../../data/samples/', import.meta.url);

export const SAMPLES = [
  { id: 'tacos-meal004', label: 'Tacos' },
  { id: 'pho-meal005', label: 'Pho' },
];
export const DEFAULT_SAMPLE = SAMPLES[0].id;
export const isSample = (id) => SAMPLES.some((s) => s.id === id);

const readJson = (id, file) => JSON.parse(readFileSync(new URL(`${id}/${file}`, ROOT), 'utf8'));
export const samplePhotoPath = (id) => new URL(`${id}/photo.jpg`, ROOT).pathname;

// A recorded item mask keeps its box as a 4-point polygon and the raw payload; re-decode it.
function redecode(mask, size) {
  if (!mask?.rawMask?.data || !mask.polygon?.length) return mask;
  const [a, , c] = mask.polygon;
  return segmentToMask(
    { box: { x1: a[0], y1: a[1], x2: c[0], y2: c[1] }, mask: mask.rawMask, id: mask.objectId, confidence: mask.confidence },
    size,
  );
}

// -> { spark, sam, photoPath, size, scale } ; scale is null when the sample has no scale photo.
export function loadSampleRuns(id) {
  if (!isSample(id)) throw new Error(`unknown sample "${id}"`);
  const photoPath = samplePhotoPath(id);
  const { size } = loadPhoto(photoPath);
  const spark = readJson(id, 'spark.json');
  const sam = readJson(id, 'sam-segment.json');
  sam.items = sam.items.map((it) => {
    const mask = redecode(it.mask, size);
    return { ...it, mask, maskStatus: mask ? mask.maskStatus : 'none', maskReason: mask ? null : (it.maskReason ?? 'not_found') };
  });
  const scale = existsSync(new URL(`${id}/scale-ocr.json`, ROOT)) ? readJson(id, 'scale-ocr.json') : null;
  return { spark, sam, photoPath, size, scale };
}
