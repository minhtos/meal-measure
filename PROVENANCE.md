# Provenance

This repository was created fresh for the Meta Global AI Developer
Hackathon (build window Oct 26 – Nov 4, 2026) and contains only work
produced during the event, except as noted below.

## Pre-existing / ported material

- **Project scaffolding template** (ported Oct 29, 2026): generic project
  plumbing — `.github/pull_request_template.md`, `.project.json`, the
  `CLAUDE.md` scaffold, and the `scripts/verify` skeleton. The template
  contains no application code; all product code was written for this
  project during the event.
- Everything else — `docs/INTEGRATION.md`, all of `src/`, `tests/`, and
  the scripts under `scripts/` — was authored during the event window.

## Data sources (not code; data files are not committed)

- **USDA FoodData Central** — nutrient data via the FDC API (public
  domain). Queried live; no dataset files are stored in this repo.
- **Open Food Facts** — packaged-food data from the bulk export,
  available under the Open Database License (ODbL); attribution:
  "Data from Open Food Facts (https://world.openfoodfacts.org)".
  The imported data files are gitignored and are not part of this repo;
  `scripts/import-off.mjs` reproduces the import from the public export.

## Benchmark material

Meal photographs and scale weights in the benchmark records are the
author's own meals, prepared, weighed, and photographed by him during
the event window (Oct 27 – Nov 3, 2026). No third-party images are used
as benchmark data.
