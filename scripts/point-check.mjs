#!/usr/bin/env node
// One LIVE point-prompt call, recorded under data/samples/point-prompt-check/.
//   node --env-file=$HOME/.config/meta-api.env scripts/point-check.mjs <photo.jpg> <x> <y> [outDir]
// x/y are normalised 0..1 (positive point). Keys come from process.env only; never written.
import { mkdirSync, writeFileSync } from 'node:fs';
import { refineWithPoints } from '../src/model/sam.js';
import { loadPhoto } from '../src/model/client.js';

const [photoPath, x, y, outArg] = process.argv.slice(2);
if (!photoPath || !x || !y) {
  console.error('usage: point-check.mjs <photo.jpg> <x> <y> [outDir]');
  process.exit(2);
}
process.env.MEAL_MEASURE_MODE = 'live';
const dir = outArg ?? new URL('../data/samples/point-prompt-check/', import.meta.url).pathname;
mkdirSync(dir, { recursive: true });
const write = (name, body) => writeFileSync(`${dir}/${name}`, typeof body === 'string' ? body : `${JSON.stringify(body, null, 2)}\n`);

const photo = loadPhoto(photoPath);
const summary = { recordedAt: new Date().toISOString(), photo: photoPath, sentSize: photo.size, inputSha256: photo.sha256, point: { x: +x, y: +y, label: 1 } };
try {
  const r = await refineWithPoints(photoPath, { points: [{ x: +x, y: +y, label: 1 }] });
  write('response.txt', r.text ?? '');
  Object.assign(summary, {
    outcome: r.mask ? 'ok' : `no-mask:${r.reason}`,
    prompt: r.provenance.prompt,
    requestId: r.provenance.requestId,
    segmentsFound: r.provenance.segments,
    objectIds: r.provenance.objectIds,
    maskStatus: r.mask?.maskStatus ?? null,
    maskError: r.mask?.maskError ?? null,
    confidence: r.mask?.confidence ?? null,
    objectId: r.mask?.objectId ?? null,
    encoding: r.mask?.raster?.encoding ?? null,
    raster: r.mask?.raster ?? null,
    bbox: r.mask?.bbox ?? null,
    areaFrac: r.mask?.areaFrac ?? null,
  });
} catch (err) {
  summary.outcome = 'error';
  summary.error = { kind: err.kind ?? null, name: err.name, message: err.message };
}
write('summary.json', summary);
console.log(JSON.stringify(summary, null, 2));
