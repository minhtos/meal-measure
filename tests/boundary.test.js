// CLAUDE.md module boundary: model/ and nutrition/ never import each other.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

function importsOf(dir, forbidden) {
  const root = new URL(`../src/${dir}/`, import.meta.url);
  return readdirSync(root)
    .filter((f) => f.endsWith('.js'))
    .flatMap((f) => [...readFileSync(new URL(f, root), 'utf8').matchAll(/from\s+['"]([^'"]+)['"]/g)]
      .map((m) => m[1]).filter((spec) => spec.includes(forbidden)).map((spec) => `${dir}/${f} -> ${spec}`));
}

test('src/model and src/nutrition do not import each other', () => {
  assert.deepEqual(importsOf('model', 'nutrition'), []);
  assert.deepEqual(importsOf('nutrition', 'model'), []);
});
