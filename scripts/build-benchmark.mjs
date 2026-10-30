#!/usr/bin/env node
// Generates web/benchmark.json from BENCHMARK.md, the published numbers. Re-run after the
// document changes:  node scripts/build-benchmark.mjs
// It reads the results table, the running summary, the meal-005 A/B, the app-variant runs and the
// SAM notes, cross-checks the computed errors and tally against what the document prints, and
// fails (writes nothing) if they disagree.
import { readFileSync, writeFileSync } from 'node:fs';

const doc = readFileSync(new URL('../BENCHMARK.md', import.meta.url), 'utf8');
const flat = (s) => s.replace(/\s+/g, ' ').trim();
const need = (m, what) => { if (!m) throw new Error(`BENCHMARK.md: could not find ${what}`); return m; };
const signed = (label) => Number(label.replace('−', '-').replace('%', ''));
const round1 = (v) => Math.round(v * 10) / 10;

// | 001 | Phở bò, home (Oct 27) | 849 g | 755 g | −11% | yes |
const meals = [...doc.matchAll(/^\|\s*(\d{3})\s*\|\s*(.+?)\s*\|\s*(\d+) g\s*\|\s*(\d+) g\s*\|\s*([+−-][\d.]+%)\s*\|\s*(?:\*\*)?(yes|no)(?:\*\*)?\s*\|$/gm)].map((m) => {
  const truthG = Number(m[3]);
  const estimateG = Number(m[4]);
  const errorPct = round1(((estimateG - truthG) / truthG) * 100);
  const printed = signed(m[5]);
  if (Math.abs(errorPct - printed) > 0.55) throw new Error(`BENCHMARK.md meal ${m[1]}: printed ${m[5]} but ${estimateG} vs ${truthG} g is ${errorPct}%`);
  const [, label, date] = /^(.*?)\s*\(([^)]*)\)$/.exec(m[2]) ?? [null, m[2], ''];
  return { id: m[1], label, date, truthG, estimateG, errorPct, errorLabel: m[5], inRange: m[6] === 'yes' };
});
if (!meals.length) throw new Error('BENCHMARK.md: no result rows found');

const abs = meals.map((m) => Math.abs(m.errorPct)).sort((a, b) => a - b);
const medianAbsErrorPct = round1(abs.length % 2 ? abs[(abs.length - 1) / 2] : (abs[abs.length / 2 - 1] + abs[abs.length / 2]) / 2);
const tally = {
  n: meals.length,
  medianAbsErrorPct,
  within20: meals.filter((m) => Math.abs(m.errorPct) <= 20).length,
  inRange: meals.filter((m) => m.inRange).length,
};
const t = need(/n = (\d+)\): median absolute error ≈ (\d+)%; (\d+) of (\d+) totals within ±20%; (\d+) of (\d+) truths inside the stated range/.exec(flat(doc)), 'the running summary');
const printedTally = { n: +t[1], medianAbsErrorPct: +t[2], within20: +t[3], inRange: +t[5] };
if (printedTally.n !== tally.n || Math.round(tally.medianAbsErrorPct) !== printedTally.medianAbsErrorPct
  || printedTally.within20 !== tally.within20 || printedTally.inRange !== tally.inRange) {
  throw new Error(`BENCHMARK.md running summary ${JSON.stringify(printedTally)} disagrees with the table ${JSON.stringify(tally)}`);
}

const ab = need(/same photo, scale cropped out\):\*\*\s+estimate\s+(\d+) g vs\. truth (\d+) g → \*\*([+−-][\d.]+%), in range\*\*.*?swung the estimate by ~(\d+) g/s.exec(doc), 'the meal-005 A/B');
const swing = need(/In meals 003 and 005[\s\S]*?\n\n/.exec(doc), 'the scale-display paragraph');
const variant = [...doc.matchAll(/- Meal (\d{3}) \(([^)]*)\): app total (\d+) g vs\.\s+truth\s+(\d+) g\s*->\s*([+−-][\d.]+%)/g)].map((m) => ({
  meal: m[1], what: m[2], appTotalG: +m[3], truthG: +m[4], errorLabel: m[5],
}));
for (const v of variant) {
  const row = need(meals.find((m) => m.id === v.meal), `table row for app-variant meal ${v.meal}`);
  if (row.truthG !== v.truthG) throw new Error(`BENCHMARK.md app-variant meal ${v.meal}: truth ${v.truthG} g differs from the table's ${row.truthG} g`);
  v.photoOnlyErrorLabel = row.errorLabel;
}
const sam = need(/- \*\*SAM 3\.1 grounding[\s\S]*?(?=\n- \*\*|\n## )/.exec(doc), 'the SAM notes')[0];
const samNotes = flat(sam.replace(/^- \*\*([^*]+)\*\*/, '$1')).split(/(?<=\.)\s+(?=[A-Z])/);
const ocr = need(/read the display as "([\d.]+ g)"[\s\S]*?\(the display\s+showed ([\d.]+ oz)\)/.exec(doc), 'the app-run scale reading');

const out = {
  source: 'BENCHMARK.md',
  note: 'Scores measure identification + portion error against database-computed truth. The totals below are food weight from a kitchen scale; nutrient truth uses the same database entries as the estimates, so database error is not part of the score.',
  meals,
  tally,
  scaleDisplay: {
    summary: flat(swing[0]),
    ab: { meal: '005', estimateG: +ab[1], truthG: +ab[2], errorLabel: ab[3], inRange: true, swingG: +ab[4], withDisplayEstimateG: meals.find((m) => m.id === '005').estimateG },
    appRunReading: { read: ocr[1], display: ocr[2], note: 'Left unconfirmed by the gate; it could not be logged.' },
  },
  appVariant: { when: 'Oct 30', runs: variant },
  samNotes,
};
// Merge the live nutrient scoring (written by scripts/score-nutrients.mjs) when it exists; verify does not need it.
let merged = '';
try {
  out.nutrientScoring = JSON.parse(readFileSync(new URL('../web/nutrient-scoring.json', import.meta.url), 'utf8'));
  merged = ' + nutrient scoring';
} catch (e) {
  if (e.code !== 'ENOENT') throw e;
}
writeFileSync(new URL('../web/benchmark.json', import.meta.url), `${JSON.stringify(out, null, 2)}\n`);
console.log(`benchmark: ${meals.length} meals, ${variant.length} app-variant runs${merged} -> web/benchmark.json`);
