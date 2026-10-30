// Mode switch + fixture replay shared by the model-call functions.
// Mock is the default whenever no Meta key is in env.
import { readFileSync } from 'node:fs';

const FIXTURE_DIR = new URL('./fixtures/', import.meta.url);

export function getMode(env = process.env) {
  return env.MEAL_MEASURE_MODE === 'mock' || !env.META_API_KEY ? 'mock' : 'live';
}

// Returns a fresh copy of the fixture recorded for photoRef, or null if none.
export function loadFixture(file, photoRef) {
  const doc = JSON.parse(readFileSync(new URL(file, FIXTURE_DIR), 'utf8'));
  const hit = doc.photos[photoRef];
  return hit ? { label: doc._label, data: structuredClone(hit) } : null;
}

export function mockProvenance(call, label) {
  return { call, mode: 'mock', fixture: true, label };
}
