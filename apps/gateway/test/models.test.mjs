import assert from 'node:assert/strict';
import test from 'node:test';
import { isRouterSlotReady, resolveLogicalRouterModelId } from '../lib/models.mjs';

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

test('resolveLogicalRouterModelId maps gemmae4 to HF E4B id when loaded', () => {
  const models = [
    { id: 'other', status: { value: 'loaded' } },
    { id: 'ggml-org/gemma-4-E4B-it-GGUF:Q4_K_M', status: { value: 'loaded' } },
  ];
  assert.equal(
    resolveLogicalRouterModelId(models, 'gemmae4'),
    'ggml-org/gemma-4-E4B-it-GGUF:Q4_K_M',
  );
});

test('resolveLogicalRouterModelId prefers exact id when present', () => {
  const models = [{ id: 'gemmae4', status: { value: 'loaded' } }];
  assert.equal(resolveLogicalRouterModelId(models, 'gemmae4'), 'gemmae4');
});
