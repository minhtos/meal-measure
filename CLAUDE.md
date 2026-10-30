# meal-measure

Photo food-MEASUREMENT tool (not a nutrition coach) — Meta Global AI Developer
Hackathon entry, build window 2026-10-27 to 2026-11-04. Scope is frozen and
pre-approved by Minh.

## Stack
- Language / runtime: dependency-free Node.js ESM, Node 22; tests via `node:test`.
  App surface: `server.mjs` (node:http) serves `web/` (no framework, no build) and a JSON
  API over the pipeline; `src/app/` holds its view / sample-replay / day-log helpers.
  Web code reaches the pipeline through `/api` only (tested).
  Mock mode replays what recorded live runs computed (`data/samples/<id>/pipeline-nutrients.json`,
  written by `scripts/record-sample.mjs` when a USDA key is set); an item with no recorded nutrients
  shows "not computed in the recorded run" and is left out of a mock log. Never price mock items
  against the test fixtures. `web/benchmark.json` is generated from `BENCHMARK.md` by
  `scripts/build-benchmark.mjs` (verify re-runs it).
- Package manager: none (zero installs). Adding any dependency needs Minh's approval.
- Verify: `./scripts/verify`
- Design source of truth: `docs/INTEGRATION.md`

## Pipeline
photo → Meta SAM segmentation masks → Meta Spark food identification →
portion from scale weight (user-entered, or scale-display OCR, always
user-confirmed) or photo estimate as a range → nutrients computed BY CODE ONLY
from USDA FoodData Central / Open Food Facts → user corrections → log with
per-item source + confidence → plain day-view sums.

## Module boundary
- `src/model/` — Meta model calls only (Spark, SAM, scale OCR) + mock mode. Never imports `src/nutrition/`.
- `src/nutrition/` — USDA / Open Food Facts lookup and grams × per-100g math. Never imports `src/model/`.
- `src/pipeline/` — the only layer that joins them; enforces the correction / anchor / confirmation rules.

## Hard rules
- The model NEVER writes or calculates nutrient numbers. Code computes
  grams × per-100g values from USDA / Open Food Facts only. Any nutrient-like
  field in a model response is discarded.
- Results are ranges (low / likely / high grams); the logged value is the range middle.
- Food identification is always user-correctable; a correction recomputes
  nutrients for the corrected food at the same portion, and the corrected
  entry is what gets logged.
- A user-supplied portion anchor (weighed / user-entered grams) overrides the
  photo estimate and is logged as HIGHER confidence.
- Scale-display OCR reads value AND unit; the reading is shown for user
  confirmation and is NEVER logged or used as an anchor silently. If scale
  total and visual estimate diverge implausibly, present both with
  plausibility reasoning and let the user decide; warn about tare when a
  weight looks like it includes the container.
- SAM prompting is coarse-to-fine (whole dish/plate first, then items); an
  item may end up mask-less — a supported state, not an error.
- Vocabulary ban in all product copy: coach, coaching, advice, recommend,
  should eat, healthy/unhealthy as judgments, diet plan. Allowed: measure,
  log, verify, estimate, range, correct.
- CUT entirely (do not build, do not scaffold): onboarding targets /
  BMR / TDEE math, macro presets of any kind, progress-vs-target views,
  weekly summaries vs targets, drift alerts. If a preset ever appears in
  future it must be named "Carb-conscious" with a not-for-insulin-dosing
  warning — but for this event presets are OUT.
- API keys live only in env files on this VM (`~/.config/meta-api.env`,
  `~/.config/usda-api.env`, mode 600). Never read, print, commit, or echo key
  values. `.env` is gitignored.
- Bring-your-own Meta API key (env/setting) so judges can run it post-event;
  recorded sample runs with provenance ship in the repo.

## Conventions
- Branches `feat/` `fix/` `chore/`; atomic imperative commits; draft PRs; Minh merges.
- Repo is PRIVATE. Never change visibility — Minh flips it himself.

## Traps
- Format: <trap> -> cost: <what it cost> -> correct move: <what to do instead>.
  Add an entry whenever an incident teaches something a future session
  would otherwise relearn the hard way. Never delete entries; correct them.
- <none recorded yet>
