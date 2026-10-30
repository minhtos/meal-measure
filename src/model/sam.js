// Contract B — SAM segmentation, coarse-to-fine: dish/plate first, then items.
// An item may come back with mask: null (mask-less is a supported state).
import { getMode, loadFixture, mockProvenance, liveNotImplemented } from './mock.js';

export async function segmentItems(photoRef, items, opts = {}) {
  if (getMode(opts.env) === 'live') liveNotImplemented('sam.segment');
  const fx = loadFixture('sam.json', photoRef);
  const rec = fx?.data ?? { dish: null, items: {} };
  return {
    dish: rec.dish ?? null, // pass 1 (coarse)
    noDishMask: !rec.dish, // not an error: dish falls back to the whole image
    items: items.map((it) => {
      const mask = rec.items?.[it.itemId] ?? null; // pass 2 (fine)
      return mask
        ? { itemId: it.itemId, mask, maskStatus: 'present', maskReason: null }
        : { itemId: it.itemId, mask: null, maskStatus: 'none', maskReason: 'not_found' };
    }),
    provenance: mockProvenance('sam.segment', fx?.label ?? 'FIXTURE — no recording for this photo; no masks'),
  };
}
