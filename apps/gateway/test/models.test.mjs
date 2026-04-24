import assert from 'node:assert/strict';
import test from 'node:test';
import { isRouterSlotReady } from '../lib/models.mjs';

test('isRouterSlotReady accepts loaded slot', () => {
  assert.equal(
    isRouterSlotReady({
      id: 'gemmae4',
      status: { value: 'loaded' },
    }),
    true,
  );
});

test('isRouterSlotReady rejects failed slot', () => {
  assert.equal(
    isRouterSlotReady({
      id: 'gemmae4',
      status: { value: 'unloaded', failed: true, exit_code: 1 },
    }),
    false,
  );
});

test('isRouterSlotReady rejects default id', () => {
  assert.equal(isRouterSlotReady({ id: 'default', status: { value: 'unloaded' } }), false);
});

test('isRouterSlotReady rejects loading slot', () => {
  assert.equal(isRouterSlotReady({ id: 'gemmae4', status: { value: 'loading' } }), false);
});
