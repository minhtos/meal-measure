// Correction sheet, plugged into the measure screen with registerItemAction. Tapping "Correct" on
// an item opens a sheet: rename (Spark look-alikes or a typed food), pick another database match
// from the near-miss dropdown, edit the grams, or refine the outline with include / exclude taps.
// Every change goes through /api; the sheet shows whatever the server sends back. A close match
// (item.nearMiss) opens the sheet on its own, once per item.
import { api } from '../api.js';
import { el, num, rangeText, NUTRIENTS } from '../util.js';
import { registerItemAction } from './measure.js';

const DB = { 'usda-fdc': 'USDA FoodData Central', off: 'Open Food Facts', fixture: 'test fixture (mock data)' };
const REASON = {
  'close-scores': 'Two database entries fit about equally well.',
  'low-score': 'The best database entry is only a loose fit.',
  'low-identification-confidence': 'The photo identification was not confident.',
  'form-concern': 'The best entry may be a dry or concentrated form.',
};
const REFINE_FAIL = {
  mock_mode: 'Refining needs a live measurement; this is recorded sample data.',
  not_found: 'The model found no region for those points.',
  mask_not_decoded: 'The returned outline could not be read.',
};
const sourceText = (s) => (s ? `${DB[s.db] ?? s.db}${s.dataType ? `, ${s.dataType}` : ''}` : 'no database entry');

const live = { ctx: null, update: null }; // the measure screen's latest hooks
const seen = new Set(); // sessionId:itemId pairs already auto-opened
const queue = [];
let dialog = null;
let sheet = null; // { itemId, sync(item) } while open
let refining = false;

const itemOf = (id) => live.ctx.result.items.find((i) => i.itemId === id);

function ensureDialog() {
  if (dialog) return dialog;
  dialog = el('dialog', { class: 'sheet', 'aria-labelledby': 'sheet-title' });
  dialog.addEventListener('click', (e) => { // a click on the backdrop lands outside the sheet's own box
    const r = dialog.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dialog.close();
  });
  dialog.addEventListener('close', () => { if (dialog.open) return; sheet = null; if (!refining) openNext(); });
  document.body.append(dialog);
  return dialog;
}

function openNext() {
  const next = queue.shift();
  if (next && live.ctx?.result?.sessionId === next.sid && itemOf(next.id) && !dialog?.open) openSheet(next.id, true);
}

function open(itemId) {
  if (refining) return;
  if (dialog?.open) { dialog.close(); }
  openSheet(itemId, false);
}

function openSheet(itemId, focusMatch) {
  const d = ensureDialog();
  const parts = [nameSection(itemId), matchSection(itemId), gramsSection(itemId), outlineSection(itemId)];
  const err = el('p', { class: 'err', role: 'alert', hidden: true });
  const report = (e) => { err.textContent = e ? e.message : ''; err.hidden = !e; };
  const title = el('h2', { id: 'sheet-title' });
  const ctl = { report };
  d.replaceChildren(
    el('div', { class: 'sheet-head' }, title, el('button', { class: 'btn small', type: 'button', onclick: () => d.close() }, 'Done')),
    ...parts.map((p) => p.node), err,
  );
  const sync = () => {
    const item = itemOf(itemId);
    if (!item) return;
    title.textContent = item.name;
    parts.forEach((p) => p.sync(item, ctl));
  };
  // One call path for every change: send it, hand the new result to the measure screen, redraw.
  ctl.act = async (promise) => {
    report(null);
    try { live.update(await promise); sync(); return true; } catch (e) { report(e); return false; }
  };
  parts.forEach((p) => p.bind?.(ctl));
  sheet = { itemId, sync };
  sync();
  d.showModal();
  if (focusMatch) d.querySelector('select.match')?.focus();
}

// ---- name: look-alikes + a typed food ----
function nameSection(itemId) {
  const was = el('p', { class: 'muted small' });
  const alts = el('div', { class: 'chips' });
  const input = el('input', { type: 'text', placeholder: 'Another food', 'aria-label': 'Type another food name', maxlength: '120' });
  const form = el('form', { class: 'inline' }, input, el('button', { class: 'btn small', type: 'submit' }, 'Use this'));
  let ctl;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (input.value.trim() && await ctl.act(api.correct(live.ctx.result.sessionId, itemId, { name: input.value.trim() }))) input.value = '';
  });
  const node = el('section', { class: 'sheet-sec' }, el('h3', {}, 'What is it?'), was, alts, form);
  return {
    node,
    bind: (c) => { ctl = c; },
    sync(item) {
      was.textContent = item.corrected ? `Identified from the photo as “${item.originalName}”.` : (typeof item.identificationConfidence === 'number' ? `Identified from the photo, ${Math.round(item.identificationConfidence * 100)}% sure.` : '');
      alts.replaceChildren(...item.alternatives.map((a) => el('button', {
        class: 'chip', type: 'button',
        onclick: () => ctl.act(api.correct(live.ctx.result.sessionId, itemId, { name: a.name })),
      }, a.name, el('small', {}, ` ${Math.round(a.confidence * 100)}%`))));
      if (!item.alternatives.length) alts.replaceChildren(el('span', { class: 'muted small' }, 'No look-alikes from the photo. Type the food below.'));
    },
  };
}

// ---- database match: the near-miss dropdown ----
function matchSection(itemId) {
  const why = el('p', { class: 'notice small', hidden: true });
  const select = el('select', { class: 'match', 'aria-label': 'Database match' });
  const prov = el('p', { class: 'muted small' });
  let ctl;
  select.addEventListener('change', () => { if (select.value) ctl.act(api.selectCandidate(live.ctx.result.sessionId, itemId, select.value)); });
  const node = el('section', { class: 'sheet-sec' }, el('h3', {}, 'Which database entry?'), why, select, prov);
  return {
    node,
    bind: (c) => { ctl = c; },
    sync(item) {
      const cands = item.matchCandidates;
      why.hidden = !item.nearMiss;
      why.textContent = item.nearMiss ? `Close match: check it. ${item.nearMissReasons.map((r) => REASON[r]).filter(Boolean).join(' ')}` : '';
      const current = item.nutrientSource && `${item.nutrientSource.db}:${item.nutrientSource.id}`;
      select.disabled = !cands.length;
      select.replaceChildren(
        cands.length ? null : el('option', { value: '' }, item.notComputedInRecordedRun ? 'Not computed in the recorded run' : 'No database matches'),
        ...cands.map((c) => el('option', { value: c.candidateId, selected: c.candidateId === current }, `${c.name} · ${c.kcalPer100g == null ? 'kcal n/a' : `${num(c.kcalPer100g)} kcal/100 g`}`)),
      );
      if (cands.length && !cands.some((c) => c.candidateId === current)) select.prepend(el('option', { value: '', selected: true, disabled: true }, 'Choose an entry…'));
      const orig = item.originalNutrientSource;
      prov.textContent = `Nutrients from ${sourceText(item.nutrientSource)}.`
        + (orig && item.nutrientSource && (orig.db !== item.nutrientSource.db || orig.id !== item.nutrientSource.id) ? ` First match was ${sourceText(orig)}.` : '');
    },
  };
}

// ---- grams: slider + number, recomputed on the server as you go ----
function gramsSection(itemId) {
  let timer = null;
  let max = 500;
  let chain = Promise.resolve(); // changes reach the server in the order they were made
  const slider = el('input', { type: 'range', min: '1', step: '1', 'aria-label': 'Grams' });
  const field = el('input', { type: 'number', inputmode: 'decimal', min: '1', step: 'any', 'aria-label': 'Grams, exact' });
  const out = el('p', { class: 'nutr' });
  const rangeLine = el('p', { class: 'muted small' });
  let ctl;
  const send = (grams) => {
    if (!(grams > 0)) return;
    if (grams > max) { max = Math.ceil(grams / 50) * 50; slider.max = String(max); }
    chain = chain.then(() => ctl.act(api.correct(live.ctx.result.sessionId, itemId, { grams })));
  };
  slider.addEventListener('input', () => {
    field.value = slider.value;
    clearTimeout(timer);
    timer = setTimeout(() => send(Number(slider.value)), 140);
  });
  field.addEventListener('change', () => { clearTimeout(timer); send(Number(field.value)); });
  const node = el('section', { class: 'sheet-sec' }, el('h3', {}, 'How many grams?'),
    el('div', { class: 'gram-row' }, slider, field, el('span', { class: 'muted' }, 'g')), rangeLine, out);
  return {
    node,
    bind: (c) => { ctl = c; },
    sync(item) {
      const g = item.grams;
      if (g) {
        max = Math.max(max, Math.ceil((g.high * 2) / 50) * 50);
        slider.max = String(max);
        if (document.activeElement !== slider && document.activeElement !== field) { slider.value = String(g.likely); field.value = String(Math.round(g.likely * 10) / 10); }
      }
      rangeLine.textContent = g ? (g.low === g.high ? `${num(g.low)} g, ${item.portionSource === 'photo-estimate' ? 'estimate' : 'your value'}.` : `Photo estimate ${rangeText(g)} g. Setting grams replaces the range with your value.`) : 'No portion yet. Enter grams.';
      out.replaceChildren(...(item.nutrients
        ? NUTRIENTS.map(([k, text, unit]) => el('span', {}, `${text} ${rangeText(item.nutrients[k], unit)}`))
        : [el('span', { class: 'muted' }, item.notComputedInRecordedRun ? 'Not computed in the recorded run.' : 'No nutrients until a database entry is chosen.')]));
    },
  };
}

// ---- outline ----
function outlineSection(itemId) {
  const note = el('p', { class: 'muted small' });
  const btn = el('button', { class: 'btn small', type: 'button' }, 'Refine outline');
  btn.addEventListener('click', () => startRefine(itemId));
  const node = el('section', { class: 'sheet-sec' }, el('h3', {}, 'Outline'), note, btn);
  return {
    node,
    sync(item) {
      const failed = live.ctx.result.warnings.find((w) => w.code === 'mask-refine-failed' && w.itemId === itemId);
      note.textContent = failed ? `${failed.message} (${REFINE_FAIL[failed.reason] ?? 'The refinement did not complete.'})`
        : item.mask ? 'Tap points on the photo to add to or trim the outline.' : 'This item has no outline yet. Tap points on the photo to draw one.';
    },
  };
}

// Refine mode: the sheet steps aside, taps on the photo become include / exclude points.
function startRefine(itemId) {
  const stage = document.querySelector('.stage');
  if (!stage) return;
  refining = true;
  dialog.close();
  const sid = live.ctx.result.sessionId;
  let mode = 1;
  const taps = [];
  const layer = el('div', { class: 'pts' });
  stage.append(layer);
  stage.classList.add('refining');
  const path = stage.querySelector(`.mask[data-id="${itemId}"]`);
  path?.classList.add('is-focus');

  const dot = (p, kept) => el('i', { class: `pt ${p.label ? 'inc' : 'exc'}${kept ? ' kept' : ''}`, style: `left:${p.x * 100}%;top:${p.y * 100}%` }, p.label ? '+' : '−');
  const msg = el('p', { class: 'refine-msg', role: 'status' }, 'Tap the photo to add points.');
  const incBtn = el('button', { class: 'btn small', type: 'button', 'aria-pressed': 'true' }, '+ Include');
  const excBtn = el('button', { class: 'btn small', type: 'button', 'aria-pressed': 'false' }, '− Exclude');
  const undo = el('button', { class: 'btn small', type: 'button' }, 'Undo');
  const apply = el('button', { class: 'btn small primary', type: 'button', disabled: true }, 'Apply');
  const cancel = el('button', { class: 'btn small', type: 'button' }, 'Cancel');
  const bar = el('div', { class: 'refine-bar', role: 'region', 'aria-label': 'Refine outline' },
    el('strong', {}, itemOf(itemId).name), el('div', { class: 'row' }, incBtn, excBtn, undo, apply, cancel), msg);
  document.body.append(bar);

  const draw = () => {
    layer.replaceChildren(...(itemOf(itemId).maskPoints ?? []).map((p) => dot(p, true)), ...taps.map((p) => dot(p, false)));
    apply.disabled = !taps.length;
  };
  const setMode = (m) => { mode = m; incBtn.setAttribute('aria-pressed', String(m === 1)); excBtn.setAttribute('aria-pressed', String(m === 0)); };
  incBtn.onclick = () => setMode(1);
  excBtn.onclick = () => setMode(0);
  undo.onclick = () => { taps.pop(); draw(); };
  const onTap = (e) => {
    const r = stage.getBoundingClientRect();
    taps.push({ x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)), label: mode });
    msg.textContent = `${taps.length} point${taps.length > 1 ? 's' : ''}. Apply when ready.`;
    draw();
  };
  const onKey = (e) => { if (e.key === 'Escape') end(); };
  function end() {
    stage.removeEventListener('click', onTap);
    document.removeEventListener('keydown', onKey);
    stage.classList.remove('refining');
    path?.classList.remove('is-focus');
    layer.remove();
    bar.remove();
    refining = false;
    if (itemOf(itemId)) openSheet(itemId, false);
  }
  cancel.onclick = end;
  apply.onclick = async () => {
    apply.disabled = true;
    msg.textContent = 'Refining…';
    try {
      const r = await api.refine(sid, itemId, taps);
      live.update(r);
      if (r.refine.ok) { end(); return; }
      msg.textContent = `Could not refine the outline. The previous outline is kept. ${REFINE_FAIL[r.refine.reason] ?? 'The refinement did not complete.'}`;
    } catch (e) {
      msg.textContent = `Could not refine the outline. The previous outline is kept. ${e.message}`;
    }
    apply.disabled = false;
  };
  stage.addEventListener('click', onTap);
  document.addEventListener('keydown', onKey);
  draw();
}

// ---- hook into the measure screen ----
registerItemAction(({ item, ctx, update }) => {
  live.ctx = ctx;
  live.update = update;
  const key = `${ctx.result.sessionId}:${item.itemId}`;
  if (item.nearMiss && !seen.has(key)) {
    seen.add(key);
    queue.push({ sid: ctx.result.sessionId, id: item.itemId });
    setTimeout(() => { if (!dialog?.open && !refining && ctx.result?.items.some((i) => i.itemId === item.itemId)) openNext(); }, 1200);
  }
  return el('button', { class: 'btn small', type: 'button', onclick: () => open(item.itemId) }, item.nearMiss ? 'Check match' : 'Correct');
});

