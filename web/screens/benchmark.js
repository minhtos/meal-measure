// Benchmark: the project's own measured error, from web/benchmark.json (generated from BENCHMARK.md).
// Misses are shown as plainly as hits.
import { api } from '../api.js';
import { el } from '../util.js';

const SCALE = 60; // the error bars span ±60%
const pct = (v) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v)}%`;

function errorBar(m) {
  const w = Math.min(Math.abs(m.errorPct), SCALE) / SCALE * 50;
  return el('div', { class: 'ebar', role: 'img', 'aria-label': `error ${m.errorLabel}` },
    el('i', { class: `fill ${m.inRange ? 'ok' : 'miss'}`, style: m.errorPct < 0 ? `right:50%;width:${w}%` : `left:50%;width:${w}%` }),
    el('i', { class: 'zero' }));
}

export async function mountBenchmark(root) {
  let b;
  try { b = await api.benchmark(); } catch (e) {
    root.append(el('section', { class: 'panel narrow' }, el('h1', {}, 'Benchmark'), el('p', { class: 'err' }, `Could not load the benchmark: ${e.message}`)));
    return;
  }
  const t = b.tally;
  const ab = b.scaleDisplay.ab;
  const miss = b.meals.filter((m) => !m.inRange);
  root.append(
    el('section', { class: 'panel head-panel' }, el('h1', {}, 'Benchmark: measured error'),
      el('p', { class: 'lede' }, b.note),
      el('p', { class: 'muted small' }, `From ${b.source}. Meals weighed on a kitchen scale; estimates come from the photo alone.`)),
    el('section', { class: 'panel' }, el('h2', {}, 'Running tally'),
      el('div', { class: 'sums' },
        tile('Meals scored', String(t.n)),
        tile('Median absolute error', `${Math.round(t.medianAbsErrorPct)}%`),
        tile('Within ±20%', `${t.within20} of ${t.n}`),
        tile('Truth inside stated range', `${t.inRange} of ${t.n}`)),
      miss.length ? el('p', { class: 'muted' }, `Misses: ${miss.map((m) => `#${m.id} (${m.errorLabel})`).join(', ')}. Each was outside the range the pipeline stated.`) : null),
    el('section', { class: 'panel' }, el('h2', {}, 'Total food weight, photo only'),
      el('table', { class: 'bench' },
        el('thead', {}, el('tr', {}, ...['Meal', 'Truth', 'Estimate', 'Error', '', 'In range'].map((h) => el('th', { scope: 'col' }, h)))),
        el('tbody', {}, ...b.meals.map((m) => el('tr', { class: m.inRange ? '' : 'miss' },
          el('th', { scope: 'row' }, `#${m.id} ${m.label}`, el('small', {}, ` ${m.date}`)),
          el('td', {}, `${m.truthG} g`), el('td', {}, `${m.estimateG} g`),
          el('td', {}, pct(m.errorPct)), el('td', { class: 'ecell' }, errorBar(m)),
          el('td', {}, m.inRange ? 'yes' : el('strong', {}, 'no'))))))),
    el('section', { class: 'panel' }, el('h2', {}, 'The scale display changed the estimate'),
      el('p', { class: 'muted' }, b.scaleDisplay.summary),
      el('div', { class: 'compare three' },
        cmp('Display in the photo', `${ab.withDisplayEstimateG} g`, pct(b.meals.find((m) => m.id === ab.meal).errorPct), true),
        cmp('Same photo, display cropped out', `${ab.estimateG} g`, ab.errorLabel, false),
        cmp('Truth (weighed)', `${ab.truthG} g`, `meal #${ab.meal}`, null)),
      el('p', { class: 'muted' }, `The visible display alone moved the estimate by about ${ab.swingG} g. In the app run, the reading was ${b.scaleDisplay.appRunReading.read} for a display showing ${b.scaleDisplay.appRunReading.display}: ${b.scaleDisplay.appRunReading.note}`)),
    b.appVariant.runs.length ? el('section', { class: 'panel' }, el('h2', {}, `Through the app (${b.appVariant.when})`),
      el('ul', { class: 'plain' }, ...b.appVariant.runs.map((r) => el('li', {}, `#${r.meal} ${r.what}: ${r.appTotalG} g against ${r.truthG} g, ${r.errorLabel} (photo-only: ${r.photoOnlyErrorLabel}).`)))) : null,
    el('section', { class: 'panel' }, el('h2', {}, 'Outlines (SAM masks)'),
      el('ul', { class: 'plain' }, ...b.samNotes.map((n) => el('li', {}, n)))),
  );
}

const tile = (k, v) => el('div', { class: 'sum' }, el('span', { class: 'k' }, k), el('strong', {}, v));
const cmp = (k, v, sub, bad) => el('div', { class: `cmp${bad === true ? ' miss' : ''}` }, el('span', { class: 'k' }, k), el('strong', {}, v), el('small', {}, sub));
