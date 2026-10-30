// Capture: meal photo, optional scale photo, recorded samples, entry points for barcode / quick meals.
import { el } from '../util.js';
import { prepareImage } from '../image.js';

export function mountCapture(root, ctx) {
  let photo = null;
  let scale = null;
  const note = el('p', { class: 'notice', role: 'status', hidden: true });
  const go = el('button', { class: 'btn primary', type: 'button', disabled: true }, 'Measure');

  const preview = el('div', { class: 'drop' }, el('span', {}, 'Take or choose a photo of the meal'));
  const scalePreview = el('div', { class: 'drop small' }, el('span', {}, 'Scale photo (optional)'));

  const picker = (label, onPick) => {
    const input = el('input', { type: 'file', accept: 'image/*', 'aria-label': label, class: 'file' });
    input.addEventListener('change', async () => {
      const f = input.files?.[0];
      if (!f) return;
      note.hidden = true;
      try { onPick(await prepareImage(f)); } catch (err) { note.textContent = err.message; note.hidden = false; }
    });
    return input;
  };
  const show = (box, img, label) => box.replaceChildren(el('img', { src: img.url, alt: label }));

  const mealInput = picker('Meal photo', (img) => { photo = img; show(preview, img, 'Meal photo preview'); go.disabled = false; });
  const scaleInput = picker('Scale photo', (img) => { scale = img; show(scalePreview, img, 'Scale photo preview'); });

  go.addEventListener('click', () => {
    ctx.pending = { photo, scale, sample: null };
    ctx.go('measure');
  });

  const sampleButtons = (ctx.config.samples ?? []).map((s) =>
    el('button', { class: 'btn', type: 'button', onclick: () => { ctx.pending = { photo: null, scale: null, sample: s.id }; ctx.go('measure'); } }, s.label));

  root.append(
    el('section', { class: 'panel' },
      el('h1', {}, 'Measure a meal'),
      el('p', { class: 'lede' }, 'Add a photo. You get each item with a gram range, and you can verify or correct it.'),
      el('div', { class: 'drops' },
        el('label', { class: 'drop-wrap' }, preview, mealInput),
        el('label', { class: 'drop-wrap' }, scalePreview, scaleInput)),
      note,
      el('div', { class: 'row' }, go),
    ),
    el('section', { class: 'panel' },
      el('h2', {}, 'Other ways in'),
      el('div', { class: 'cards' },
        el('a', { class: 'card', href: '#/barcode' }, el('strong', {}, 'Barcode'), el('span', {}, 'Measure a packaged food from its label')),
        el('a', { class: 'card', href: '#/quick' }, el('strong', {}, 'Quick meals'), el('span', {}, 'Log a meal you repeat')),
      ),
    ),
    sampleButtons.length ? el('section', { class: 'panel' },
      el('h2', {}, 'Try a recorded sample'),
      el('p', { class: 'lede' }, 'Recorded runs of the live pipeline. Works offline, labelled as mock data.'),
      el('div', { class: 'row' }, ...sampleButtons),
    ) : null,
  );
}
