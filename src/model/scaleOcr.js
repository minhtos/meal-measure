// Contract C — scale-display OCR. Reads what the display says and nothing more:
// no unit conversion here, and status is ALWAYS 'unconfirmed' (or 'unreadable').
// Only src/pipeline/measure.js confirmScale can make a reading usable.
import { getMode, loadFixture, mockProvenance } from './mock.js';
import { loadPhoto, sparkChat, provenanceOf, ModelCallError } from './client.js';
import { parseJsonReply } from './spark.js';

const UNITS = new Set(['g', 'kg', 'oz', 'lb', 'lb_oz', 'ml']);

export const OCR_PROMPT = `Read the numeric display of the kitchen scale in this photo. Transcribe only what the display shows; do not estimate, convert units, or describe food.
Reply with JSON only: {"rawText":"exact display text","value":number,"unit":"g|kg|oz|lb|lb_oz|ml","secondary":null or {"value":number,"unit":"oz"} (only for lb+oz displays)}.
If no scale display is readable reply {"rawText":"","value":null,"unit":null}.`;

// Same gate for mock and live: whatever status the model claims is ignored.
function toReading(r, provenance) {
  const readable = r && typeof r.value === 'number' && typeof r.unit === 'string' && (provenance.mode === 'mock' || UNITS.has(r.unit));
  if (!readable) return { value: null, unit: null, rawText: typeof r?.rawText === 'string' ? r.rawText : '', status: 'unreadable', provenance };
  return { value: r.value, unit: r.unit, secondary: r.secondary ?? null, rawText: String(r.rawText ?? ''), status: 'unconfirmed', provenance };
}

async function readLive(photoRef, opts) {
  const photo = loadPhoto(photoRef); // live: photoRef is a JPEG file path
  try {
    const reply = await sparkChat(OCR_PROMPT, photo, opts);
    return toReading(parseJsonReply(reply.text), provenanceOf('scale.ocr', photo, reply));
  } catch (err) {
    if (!(err instanceof ModelCallError)) throw err;
    return toReading(null, { call: 'scale.ocr', mode: 'live', inputSha256: photo.sha256, at: new Date().toISOString(), error: { kind: err.kind, message: err.message } });
  }
}

export async function readScale(photoRef, opts = {}) {
  if (getMode(opts.env) === 'live') return readLive(photoRef, opts);
  const fx = loadFixture('scale-ocr.json', photoRef);
  return toReading(fx?.data, mockProvenance('scale.ocr', fx?.label ?? 'FIXTURE — no recording for this photo'));
}
