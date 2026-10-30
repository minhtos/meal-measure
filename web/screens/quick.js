// Quick meals: meals you already logged with a correction or entered grams, ready to log again
// without a photo. The nutrients and provenance are the ones stored with the original entry.
import { api } from '../api.js';
import { el, today } from '../util.js';

export async function mountQuick(root, ctx) {
  const list = el('ul', { class: 'quick-list' });
  const err = el('p', { class: 'err', role: 'alert', hidden: true });
  root.append(el('section', { class: 'panel' },
    el('h1', {}, 'Quick meals'),
    el('p', { class: 'lede' }, 'Meals you logged with a corrected food or your own grams. Log one again without a photo.'),
    list, err),
  el('a', { class: 'btn', href: '#/capture' }, 'Back to measure'));

  let meals;
  try { ({ meals } = await api.quickMeals()); } catch (e) { err.textContent = e.message; err.hidden = false; return; }
  if (!meals.length) {
    list.replaceChildren(el('li', { class: 'muted' }, 'Nothing here yet. A meal appears after you log it with a correction or entered grams.'));
    return;
  }
  list.replaceChildren(...meals.map((m) => {
    const btn = el('button', { class: 'btn small primary', type: 'button' }, 'Log again');
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      err.hidden = true;
      try { await api.logQuickMeal(m.quickId, today()); ctx.go('log'); } catch (e) { err.textContent = `Not logged: ${e.message}`; err.hidden = false; btn.disabled = false; }
    });
    return el('li', { class: 'quick' },
      el('div', {}, el('strong', {}, m.items.map((i) => i.name).join(', ')),
        el('p', { class: 'muted small' }, `${m.items.map((i) => `${Math.round(i.loggedGrams)} g`).join(' + ')} · about ${m.kcal} kcal`)),
      btn);
  }));
}
