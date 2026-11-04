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
| 006 | Cereal bowl, home (Oct 31) | 136 g | 76 g | −44% | **no** |
| 007 | Beef kalbi + rice + gai lan bowl, home (Nov 4) | 235 g | 335 g | +43% | yes |

Running summary (n = 7): median absolute error ≈ 31%; 3 of 7 totals within
±20%; 4 of 7 truths inside the stated range.

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
- **Broth entry choice:** in the nutrient scoring, broth resolved to a
  branded entry (FDC 2093746, 4 kcal/100 g), and broth candidates span
  1–29 kcal/100 g, so broth-heavy meals are sensitive to entry choice.
  Truth and estimate share the entry, so the % errors are unaffected, but
  absolute kcal are not.
- **Database gaps:** USDA has no defensible entry for bánh cuốn; the
  matcher labels such items with their source tier instead of inventing
  numbers (see the design doc's tier rules).
- **Matcher ranking (meal 006):** the database matcher ranked plainly
  wrong entries first for two of three items: freeze-dried strawberries
  drew freeze-dried herbs (chives, parsley, shallots), and cow's milk
  drew milk crackers (446 kcal/100 g) with fluid milk absent from the
  top candidates. Priced with those entries the meal's calories land
  about +81% high (label-based truth ~190 kcal) while its weight lands
  -44% low. This is the failure the correction dropdown and near-miss
  flag exist for: an estimate is only as good as the entry the user
  can see and change.
- **Scale-OCR digit confusion (Nov 4, demo run):** the scale-OCR step
  read a seven-segment display showing 545 g as "245" (5 misread as 2).
  The reading never anchored silently: the confirm panel shows the raw
  OCR text for the user to check against the display, and the
  divergence check flagged the confirmed value as implausible (245 g
  against a 485-985 g photo range) and asked the user to choose before
  anything was distributed. Both guards worked as designed; the OCR
  step itself remains a known weak point on seven-segment displays.

## Provenance

Photos and weights are the author's own meals, weighed and photographed
by him during the event window. Per-meal records (photos, scale readings,
model outputs) are kept with the project records.

## Pipeline variant (Oct 30, live through the app)

First end-to-end live runs of the app pipeline (SAM-first, scale-blind
identification prompt, same photos):
- Meal 004 (tacos): app total 312 g vs. truth 278 g -> +12% (photo-only
  baseline was +20%).
- Meal 005 (pho, scale visible in frame): app total 630 g vs. truth
  846 g -> -26% (unguarded photo-only was -58%). The blindness rule cut
  the anchoring error by more than half; submersion error remains.
- The same run's scale OCR read the display as "595.4 g" (the display
  showed 59.54 oz). The reading stayed unconfirmed and could not be
  logged - the confirmation gate, not the OCR, is what makes scale
  readings safe to use.
- Meal 006 (cereal bowl, natural photo, first meal under the Oct 30
  protocol): app total 76 g vs. truth 136 g -> -44%. Identification was
  correct on all three items; the miss was the milk, mostly hidden in
  the finished bowl (40 g likely vs. 106 g truth, out of range). Cereal
  (+15%) and freeze-dried strawberries (+20%) were in range.
- Meal 006, second photo (finished bowl on the scale, display in
  grams, brands in frame): app total 172 g -> +26%, truth inside the
  summed range; no sign of display use by the estimator, and the scale
  OCR read 495 g with the correct unit, unconfirmed. Brand marks
  (Horizon Organic, freeze-dried strawberries) were read as context.
- Meal 007 (beef kalbi + rice + gai lan bowl, natural photo): app total
  335 g vs. truth 235 g -> +43%, truth inside the summed range
  (230-455 g). Rice +28% and kalbi +32% in range - Spark named the kalbi
  "braised beef short ribs" (right cut, wrong preparation), and the
  matcher's top rice entry was glutinous rice, flagged near-miss. The
  miss was the gai lan: 75 g likely vs. 35 g truth (+114%) with the
  database entry exactly right - a small pile of greens reads bigger
  than it is.
- Meal 007, second photo (finished bowl on the scale, display in
  grams): app total 290 g -> +23%, truth in range; no display
  anchoring. The species call flipped between the two photos of the
  same dish - "grilled pork chop" here, with grams nearly exact
  (110 g vs. 114 g truth) - while the matcher priced a veal chop
  entry. Identification is less stable than portion estimation.

## Nutrient-level scoring

<!-- generated by scripts/score-nutrients.mjs; do not edit by hand -->
Meal-level kcal / protein / carbs / fat for the component-weighed pho meals, from live USDA FoodData Central lookups. Truth and estimate use the **same** entry per component, so this scores identification-and-portion error only, not database error. Component weights: `data/benchmark-components.json`.

| Component entry | FDC id | Data type | USDA name | kcal /100 g |
|---|---|---|---|---|
| broth | 2093746 | Branded | BEEF BROTH | 4 |
| rice-noodles | 168914 | SR Legacy | Rice noodles, cooked | 108 |
| raw-beef | 746760 | Foundation | Beef, round, eye of round roast, boneless, separable lean only, trimmed to 0" fat, select, raw | 122 |
| cooked-beef | 2705851 | Survey (FNDDS) | Beef, brisket | 231 |
| beef-meatballs | 2626055 | Branded | BEEF MEATBALLS | 316 |
| garnish | 2709768 | Survey (FNDDS) | Bean sprouts, raw | 30 |

Components map to entries as: broth → broth; rice-noodles → rice-noodles; raw-beef-slices → raw-beef; cooked-beef → cooked-beef; beef-cuts → cooked-beef; beef-meatballs → beef-meatballs; onion-herbs → garnish; garnish-sprouts-onion-herbs → garnish; garnish → garnish.

| Meal | Variant | Weight truth → est. | kcal truth → est. (err) | Protein g (err) | Carbs g (err) | Fat g (err) |
|---|---|---|---|---|---|---|
| 003 | estimate-photo | 882 → 608 g | 888.3 → 635.8 (−28.4%) | 60.6 → 39.2 (−35.3%) | 68.2 → 42.3 (−38%) | 40.3 → 33.9 (−16%) |
| 005 | estimate-photo-scale-visible | 846 → 355 g | 719.9 → 349.2 (−51.5%) | 56.2 → 24.6 (−56.2%) | 68.7 → 27.1 (−60.6%) | 23.4 → 15.3 (−34.4%) |
| 005 | estimate-photo-scale-cropped-AB | 846 → 870 g | 719.9 → 683.9 (−5%) | 56.2 → 53.9 (−4.1%) | 68.7 → 49.8 (−27.5%) | 23.4 → 29.1 (+24.6%) |
| 005 | app-pipeline-run | 846 → 630 g | 719.9 → 552.1 (−23.3%) | 56.2 → 42.7 (−24%) | 68.7 → 40.8 (−40.6%) | 23.4 → 23.8 (+1.8%) |

**Notes.**
- Garnish (bean sprouts, onion, herbs) is priced with one representative entry (mung bean sprouts); an approximation, small in absolute terms. `beef-cuts` (meal 003) uses the cooked-beef entry.
- The `app-pipeline-run` row prices the recorded Spark per-item likely grams (`data/samples/pho-meal005/spark.json`) with these entries; it is not the app's own recorded nutrient output.
- Selection is rank-by-name-match, skipping form-flagged candidates (dry, concentrate, bouillon). Runners-up per entry are in the generated `web/nutrient-scoring.json` input log below the table in the script output, not here.
