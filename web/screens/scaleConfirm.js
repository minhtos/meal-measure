// Scale-confirm flow, plugged into the measure screen with registerResultPanel.
// An OCR reading is never used until the user confirms it here: the raw text, the parsed value and
// an explicit unit picker (oz vs g is a documented hazard). If the confirmed scale value and the
// photo estimate diverge, both are shown with the pipeline's reasoning and the user chooses.
import { api } from '../api.js';
import { el, num } from '../util.js';
import { registerResultPanel } from './measure.js';

const UNITS = [['g', 'grams (g)'], ['oz', 'ounces (oz)'], ['kg', 'kilograms (kg)'], ['lb', 'pounds (lb)'], ['lb_oz', 'pounds + ounces']];
const drafts = new Map(); // sessionId -> { value, unit, secondary, itemId } while the user is editing

function readingForm(result, update, { submitLabel, lockedItemId = null, onDone }) {
  const s = result.scale;
  const draft = drafts.get(result.sessionId) ?? { value: String(s.value ?? ''), unit: s.unit ?? '', secondary: s.secondary?.value != null ? String(s.secondary.value) : '', itemId: lockedItemId ?? (result.items.length === 1 ? result.items[0].itemId : '') };
  drafts.set(result.sessionId, draft);

  const value = el('input', { type: 'number', inputmode: 'decimal', step: 'any', min: '0', value: draft.value, 'aria-label': 'Value on the display' });
  const unit = el('select', { 'aria-label': 'Unit on the display' },
    UNITS.some(([u]) => u === draft.unit) ? null : el('option', { value: '', selected: true, disabled: true }, 'Choose the unit…'),
    ...UNITS.map(([u, label]) => el('option', { value: u, selected: u === draft.unit }, label)));
  const secondary = el('input', { type: 'number', inputmode: 'decimal', step: 'any', min: '0', value: draft.secondary, 'aria-label': 'Ounces', placeholder: 'oz' });
  const itemPick = el('select', { 'aria-label': 'Item on the scale' },
    el('option', { value: '', selected: !draft.itemId, disabled: true }, 'Choose the item…'),
    ...result.items.map((i) => el('option', { value: i.itemId, selected: i.itemId === draft.itemId }, i.name)));
  const secLabel = el('label', {}, 'Ounces', secondary);
  const err = el('p', { class: 'err', role: 'alert', hidden: true });
  const submit = el('button', { class: 'btn primary small', type: 'submit' });

  const changed = () => String(value.value) !== String(s.value ?? '') || unit.value !== (s.unit ?? '');
  const refresh = () => {
    Object.assign(draft, { value: value.value, unit: unit.value, secondary: secondary.value, itemId: itemPick.value || draft.itemId });
    secLabel.hidden = unit.value !== 'lb_oz';
    submit.textContent = changed() ? 'Edit and confirm' : submitLabel;
    submit.disabled = !(Number(value.value) > 0) || !unit.value || (!lockedItemId && !itemPick.value);
  };
  [value, unit, secondary, itemPick].forEach((n) => n.addEventListener('input', refresh));

  const form = el('form', { class: 'scale-form' },
    el('label', {}, 'Value', value),
    el('label', {}, 'Unit on the display', unit),
    secLabel,
    lockedItemId || result.items.length === 1 ? null : el('label', {}, 'Which item was on the scale?', itemPick),
    submit, err);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    submit.disabled = true;
    err.hidden = true;
    try {
      const body = { value: Number(value.value), unit: unit.value, itemId: lockedItemId ?? (itemPick.value || draft.itemId) };
      if (unit.value === 'lb_oz') body.secondary = { value: Number(secondary.value || 0), unit: 'oz' };
      const r = await api.scaleConfirm(result.sessionId, body);
      drafts.delete(result.sessionId);
      update(r);
      onDone?.(r);
    } catch (e2) {
      err.textContent = e2.message;
      err.hidden = false;
      refresh();
    }
  });
  refresh();
  return form;
}

function unconfirmedPanel(result, update) {
  const s = result.scale;
  return el('section', { class: 'panel scale-panel', 'aria-label': 'Confirm the scale reading' },
    el('h2', {}, 'Confirm the scale reading'),
    el('p', { class: 'muted' }, 'This was read from the display photo. It is not used, and the meal cannot be logged, until you confirm it.'),
    el('div', { class: 'raw' }, el('span', { class: 'k' }, 'Raw text from the display'), el('code', {}, s.rawText || '(empty)')),
    el('p', { class: 'muted small' }, `Parsed as ${s.value ?? '?'} ${s.unit ?? '(no unit)'}. Check the unit against the display: ounces are often misread as grams.`),
    readingForm(result, update, { submitLabel: 'Confirm' }),
  );
}

// Confirmed, but the scale and the photo disagree: nothing is picked for the user.
function divergencePanel(result, update) {
  const s = result.scale;
  const w = result.warnings.find((x) => x.code === 'scale-divergence');
  const itemId = s.itemIds[0];
  const item = result.items.find((i) => i.itemId === itemId);
  const choose = (decision) => async (e) => {
    const btns = e.currentTarget.parentElement.querySelectorAll('button');
    btns.forEach((b) => { b.disabled = true; });
    try { update(await api.scaleConfirm(result.sessionId, { decision })); } catch (err) { msg.textContent = err.message; msg.hidden = false; btns.forEach((b) => { b.disabled = false; }); }
  };
  const msg = el('p', { class: 'err', role: 'alert', hidden: true });
  const photo = w?.photoRange ?? item?.photoEstimate;
  return el('section', { class: 'panel scale-panel', 'aria-label': 'Scale and photo disagree' },
    el('h2', {}, 'The scale and the photo disagree'),
    el('p', { class: 'muted' }, `For ${item?.name ?? 'the item'}. Pick the one you trust; nothing is chosen for you.`),
    el('div', { class: 'compare' },
      el('div', { class: 'cmp' }, el('span', { class: 'k' }, 'Scale reading (confirmed)'), el('strong', {}, `${num(s.grams)} g`), el('small', {}, `${s.value} ${s.unit}${s.edited ? ', edited by you' : ''}`)),
      el('div', { class: 'cmp' }, el('span', { class: 'k' }, 'Photo estimate'), el('strong', {}, photo ? `${num(photo.low)}–${num(photo.high)} g` : 'none'), el('small', {}, 'range from the photo alone'))),
    el('ul', { class: 'why' }, ...(w?.reasoning ?? [w?.message].filter(Boolean)).map((r) => el('li', {}, r))),
    el('div', { class: 'row' },
      el('button', { class: 'btn small primary', type: 'button', onclick: choose('use-scale') }, 'Use the scale value'),
      el('button', { class: 'btn small', type: 'button', onclick: choose('use-photo') }, 'Keep the photo estimate'),
      el('button', { class: 'btn small', type: 'button', onclick: choose('enter-grams') }, 'I’ll enter grams')),
    msg,
    el('details', { class: 'fix' }, el('summary', {}, 'The reading is wrong? Edit it'),
      readingForm(result, update, { submitLabel: 'Confirm again', lockedItemId: itemId })),
  );
}

registerResultPanel(({ result, update }) => {
  const s = result.scale;
  if (s?.status === 'unconfirmed') return unconfirmedPanel(result, update);
  if (s?.status === 'confirmed' && s.decision === 'pending') return divergencePanel(result, update);
  return null;
});
