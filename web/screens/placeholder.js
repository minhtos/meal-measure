// Simple holding panel for entry points that land in part 2.
import { el } from '../util.js';

export function mountPlaceholder(root, ctx, { title, body }) {
  root.append(el('section', { class: 'panel narrow' },
    el('h1', {}, title),
    el('p', { class: 'lede' }, body),
    el('a', { class: 'btn', href: '#/capture' }, 'Back to measure'),
  ));
}
