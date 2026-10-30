#!/usr/bin/env node
// Records one LIVE run into data/samples/<id>/ (docs/INTEGRATION.md §10).
//   node --env-file=$HOME/.config/meta-api.env scripts/record-sample.mjs <id> <photo.jpg> [--scale]
// Keys come from process.env only and are never written to disk.
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { identifyFood } from '../src/model/spark.js';
import { segmentItems } from '../src/model/sam.js';
import { readScale } from '../src/model/scaleOcr.js';
import { loadPhoto, SPARK_MODEL, SAM_MODEL } from '../src/model/client.js';
import { entryFromRuns, recordedNutrients } from '../src/pipeline/measure.js';
import { hasUsdaKey } from '../src/nutrition/usda.js';

const [id, photoPath, ...flags] = process.argv.slice(2);
if (!id || !photoPath) {
  console.error('usage: record-sample.mjs <id> <photo.jpg> [--scale]');
  process.exit(2);
}
if (!process.env.META_API_KEY) {
  console.error('record-sample: META_API_KEY not in env (load it with node --env-file)');
  process.exit(2);
}
process.env.MEAL_MEASURE_MODE = 'live';

const dir = new URL(`../data/samples/${id}/`, import.meta.url).pathname;
mkdirSync(dir, { recursive: true });
const write = (name, obj) => writeFileSync(`${dir}${name}`, `${JSON.stringify(obj, null, 2)}\n`);

const photo = loadPhoto(photoPath);
writeFileSync(`${dir}photo.jpg`, photo.bytes); // EXIF-stripped, so its sha256 matches provenance

const spark = await identifyFood(photoPath);
write('spark.json', spark);
const sam = await segmentItems(photoPath, spark.items);
write('sam-segment.json', sam);
// The nutrients this run computes (USDA, by code) are kept so mock mode can replay them. Without a
// USDA key the pipeline would price against the test fixtures, so nothing is written in that case.
if (hasUsdaKey(process.env)) {
  write('pipeline-nutrients.json', { recordedAt: new Date().toISOString(), mode: 'live', ...recordedNutrients(await entryFromRuns(photoPath, spark, sam)) });
} else {
  console.error('record-sample: USDA_API_KEY not in env; pipeline-nutrients.json NOT written (mock logging stays unavailable)');
}
const calls = [spark.provenance, ...sam.provenance.calls];
if (flags.includes('--scale')) {
  const scale = await readScale(photoPath);
  write('scale-ocr.json', scale);
  calls.push(scale.provenance);
}

write('provenance.json', {
  recordedAt: new Date().toISOString(),
  mode: 'live',
  models: { spark: SPARK_MODEL, sam: SAM_MODEL },
  requestIds: calls.map((c) => ({ call: c.call, prompt: c.prompt ?? null, requestId: c.requestId ?? null })),
  inputSha256: photo.sha256, // EXIF-stripped bytes actually sent
  codeVersion: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  recordedBy: 'scripts/record-sample.mjs',
  errors: calls.filter((c) => c.error).map((c) => ({ call: c.call, ...c.error })),
});
console.log(`recorded ${id}: ${spark.items.length} items, ${sam.items.filter((i) => i.mask).length} boxed, ${calls.length} calls`);
