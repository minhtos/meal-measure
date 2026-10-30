// Contract C — scale-display OCR. Reads what the display says and nothing more:
// no unit conversion here, and status is ALWAYS 'unconfirmed' (or 'unreadable').
// Only src/pipeline/measure.js confirmScale can make a reading usable.
import { getMode, loadFixture, mockProvenance, liveNotImplemented } from './mock.js';

export async function readScale(photoRef, opts = {}) {
  if (getMode(opts.env) === 'live') liveNotImplemented('scale.ocr');
  const fx = loadFixture('scale-ocr.json', photoRef);
  const r = fx?.data;
  const provenance = mockProvenance('scale.ocr', fx?.label ?? 'FIXTURE — no recording for this photo');
  const readable = r && typeof r.value === 'number' && typeof r.unit === 'string';
  if (!readable) return { value: null, unit: null, rawText: r?.rawText ?? '', status: 'unreadable', provenance };
  // Whatever status the model claims is ignored.
  return {
    value: r.value,
    unit: r.unit,
    secondary: r.secondary ?? null,
    rawText: String(r.rawText ?? ''),
    status: 'unconfirmed',
    provenance,
  };
}
