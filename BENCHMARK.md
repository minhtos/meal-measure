# Benchmark — measured error, published

This project publishes its own measured error. Ground truth comes from meals
weighed on a kitchen scale during the build window (Oct 27 – Nov 3, 2026);
estimates come from the photo-only pipeline (Muse Spark vision, no scale
input) unless a row says otherwise. Misses are included. The set is still
growing; this file is updated as meals are scored.

## Method

- **Component tier:** the dish is assembled on the scale; each ingredient's
  weight is the difference between successive readings (container tare
  recorded once per container and reused).
- **Total tier:** full container minus empty container (before/after photos).
- Truth nutrients, where shown, are computed with the same database entries
  as the estimates, so the comparison isolates identification + portion
  error, not database error.
- A meal scores "in range" when the true total falls inside the pipeline's
  own stated low–high range.

## Results — total food weight, photo-only

| # | Meal (date) | Truth | Estimate (likely) | Error | In range |
|---|---|---|---|---|---|
| 001 | Phở bò, home (Oct 27) | 849 g | 755 g | −11% | yes |
| 002 | Bánh cuốn, home (Oct 28) | 323 g | 328 g | +1.5% | yes |
| 003 | Phở bò, component-weighed (Oct 28) | 882 g | 608 g | −31% | **no** |
| 004 | Tacos de trompo, restaurant (Oct 29) | 278 g | 333 g | +20% | yes |
| 005 | Phở bò, component-weighed (Oct 29) | 846 g | 355 g | −58% | **no** |

Running summary (n = 5): median absolute error ≈ 20%; 3 of 5 totals within
±20%; 3 of 5 truths inside the stated range.

## The scale-display hazard (meals 003–005)

In meals 003 and 005 a scale display was visible in the test photo, showing
ounces. The vision model read the display as grams ("60.81 oz" → "608.1",
"59.54 oz" → "595.4") and anchored its estimate to the misread number —
in 005 it additionally subtracted an assumed container weight. In meal 004
it read the display but rejected the value as implausible and estimated
visually. Three photos, three different behaviors.

**Controlled A/B (meal 005, same photo, scale cropped out):** estimate
870 g vs. truth 846 g → **+2.8%, in range**. The visible display alone
swung the estimate by ~515 g.

Design consequences, implemented in the pipeline:
- The vision estimate is computed without using any displayed readout
  (the identification prompt instructs the model to disregard scale
  displays), and scale values enter only through the separate OCR step.
- OCR readings carry value **and unit**, are converted by code, and stay
  `unconfirmed` until the user confirms them; an unconfirmed reading
  cannot be logged.
- When the confirmed scale total and the photo estimate disagree, both
  are presented with plausibility reasoning (known container weights,
  component-sum checks); the user decides. Nothing is silently picked.

## Other findings so far

- **Submersion:** ingredients hidden under broth are systematically
  underestimated (meal 005 noodles −31% even in the scale-free A/B);
  visible toppings are over-weighted (meatballs +63% in the same A/B,
  +89% before a truth correction in meal 003). Photo composition drives
  error more than dish identity does.
- **SAM 3.1 grounding (scored separately):** dish-level and unit-level
  prompts ground reliably ("the bowl" 3/3 meals, "the tacos" → exactly
  3 segments). Filling-level prompts inside a bowl ("the meatballs",
  specific dish items) returned no segments in most attempts. Prompts
  are kept to the simplest noun form first; items without a mask remain
  fully loggable (mask-less is a supported state).
- **Database gaps:** USDA has no defensible entry for bánh cuốn; the
  matcher labels such items with their source tier instead of inventing
  numbers (see the design doc's tier rules).

## Provenance

Photos and weights are the author's own meals, weighed and photographed
by him during the event window. Per-meal records (photos, scale readings,
model outputs) are kept with the project records.
