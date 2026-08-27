import test from 'node:test';
import assert from 'node:assert/strict';

import { createPathReplaySession } from './state.js';

test('path replay advances a repeated normalized session seed and never persists it', () => {
  const values = new Map([
    ['parallax.pathReplay.v1', JSON.stringify({ mode: 'stressed', seed: 77 })],
  ]);
  const storage = {
    getItem(key){ return values.get(key) ?? null; },
    setItem(key, value){ values.set(key, value); },
  };
  const generated = [101, 0x100000000 + 101, 202];
  const session = createPathReplaySession({
    storage,
    generateSeed: () => generated.shift(),
  });

  assert.deepEqual(
    JSON.parse(values.get('parallax.pathReplay.v1')),
    { mode: 'stressed' }
  );
  assert.equal(session.pathReplay.mode, 'stressed');
  assert.equal(session.pathReplay.seed, 101);
  assert.equal(session.pathReplay.seed, 101);
  assert.equal(generated.length, 2);

  session.savePathReplay();
  assert.deepEqual(
    JSON.parse(values.get('parallax.pathReplay.v1')),
    { mode: 'stressed' }
  );

  assert.equal(session.refreshPathSeed(), 102);
  assert.equal(session.pathReplay.seed, 102);
  assert.equal(generated.length, 1);

  assert.equal(session.refreshPathSeed(), 202);
  assert.equal(session.pathReplay.seed, 202);
  assert.equal(generated.length, 0);

  session.savePathReplay();
  assert.deepEqual(
    JSON.parse(values.get('parallax.pathReplay.v1')),
    { mode: 'stressed' }
  );
});
