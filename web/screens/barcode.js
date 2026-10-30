// Barcode: type (or scan from a photo, where the browser can) a UPC / EAN, see the label data, enter
// the grams eaten, and log. Lookup runs against the local Open Food Facts import, so it works offline.
import { api } from '../api.js';
import { el, rangeText, today, NUTRIENTS } from '../util.js';

const MISS = {
  unmatched: 'That barcode is not in the product data on this device. Measure from a photo instead, or check the digits.',
  incomplete: 'This product has no complete nutrition label in the data, so it cannot be priced.',
  unavailable: 'The product data is not installed on this device yet (scripts/import-off.mjs imports it).',
  'lookup-failed': 'The product lookup did not complete. Try again.',
};

export function mountBarcode(root, ctx) {
  const code = el('input', { type: 'text', inputmode: 'numeric', pattern: '\\d{6,14}', placeholder: 'Barcode digits', 'aria-label': 'Barcode digits', autocomplete: 'off' });
  const find = el('button', { class: 'btn primary', type: 'submit' }, 'Look up');
  const err = el('p', { class: 'err', role: 'alert', hidden: true });
  const result = el('div', { class: 'barcode-result', 'aria-live': 'polite' });
  const form = el('form', { class: 'inline wide' }, code, find);

  const fail = (text) => { err.textContent = text; err.hidden = false; result.replaceChildren(); };

  async function lookup(digits) {
    err.hidden = true;
    result.replaceChildren(el('p', { class: 'muted' }, 'Looking up…'));
    try {
      const r = await api.barcode(digits);
      if (r.status !== 'matched') { fail(MISS[r.status] ?? 'No match.'); return; }
      showProduct(r);
    } catch (e) { fail(e.message); }
  }

  function showProduct(r) {
    const grams = el('input', { type: 'number', inputmode: 'decimal', min: '1', step: 'any', 'aria-label': 'Grams eaten', value: r.servingGrams ?? '' });
    const go = el('form', { class: 'inline wide' }, el('label', {}, 'Grams eaten', grams), el('button', { class: 'btn small primary', type: 'submit' }, 'Measure'));
    const out = el('div', {});
    result.replaceChildren(el('section', { class: 'panel' },
      el('h2', {}, r.name),
      el('p', { class: 'muted' }, `Label data per 100 g: ${NUTRIENTS.map(([k, t, u]) => `${t} ${r.per100g[k]}${u}`).join(', ')}.`),
      r.servingGrams ? el('p', { class: 'muted small' }, `The label lists a serving of ${r.servingGrams} g. Change it to what you ate.`) : el('p', { class: 'muted small' }, 'Enter the grams you ate.'),
      go, out));
    go.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!(Number(grams.value) > 0)) { out.replaceChildren(el('p', { class: 'err' }, 'Enter a weight in grams.')); return; }
      try {
        const m = await api.barcode(r.code, Number(grams.value));
        const item = m.entry.items[0];
        const log = el('button', { class: 'btn primary', type: 'button' }, 'Log this');
        const logErr = el('p', { class: 'err', role: 'alert', hidden: true });
        log.addEventListener('click', async () => {
          log.disabled = true;
          try { await api.log(m.sessionId, today()); ctx.go('log'); } catch (e2) { logErr.textContent = `Not logged yet: ${e2.message}`; logErr.hidden = false; log.disabled = false; }
        });
        out.replaceChildren(
          el('p', { class: 'nutr' }, ...NUTRIENTS.map(([k, t, u]) => el('span', {}, `${t} ${rangeText(item.nutrients[k], u)}`))),
          el('p', { class: 'muted small' }, `${item.grams.likely} g, entered by you. Nutrients computed from ${item.nutrientSource.db === 'off' ? 'Open Food Facts' : 'USDA FoodData Central'} label data.`),
          el('div', { class: 'row' }, log), logErr);
      } catch (e2) { out.replaceChildren(el('p', { class: 'err' }, e2.message)); }
    });
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const digits = code.value.replace(/\s+/g, '');
    if (!/^\d{6,14}$/.test(digits)) { fail('A barcode is 6 to 14 digits.'); return; }
    lookup(digits);
  });

  // Optional: read a barcode from a photo where the browser has BarcodeDetector.
  let scan = null;
  if ('BarcodeDetector' in window) {
    const pick = el('input', { type: 'file', accept: 'image/*', capture: 'environment', class: 'file', 'aria-label': 'Scan a barcode from a photo' });
    pick.addEventListener('change', async () => {
      const f = pick.files?.[0];
      if (!f) return;
      try {
        const found = await new window.BarcodeDetector().detect(await createImageBitmap(f));
        if (!found.length) { fail('No barcode found in that photo. Type the digits instead.'); return; }
        code.value = found[0].rawValue;
        lookup(found[0].rawValue);
      } catch { fail('That photo could not be read. Type the digits instead.'); }
    });
    scan = el('label', { class: 'btn drop-wrap-inline' }, 'Scan from a photo', pick);
  }

  root.append(el('section', { class: 'panel' },
    el('h1', {}, 'Barcode'),
    el('p', { class: 'lede' }, 'Measure a packaged food from its label data. Nutrients are computed from the product record and the grams you enter.'),
    form, scan, err),
  result,
  el('a', { class: 'btn', href: '#/capture' }, 'Back to measure'));
}
