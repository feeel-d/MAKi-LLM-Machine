import test from 'node:test';
import assert from 'node:assert/strict';
import { assertServiceKey, getRequestId } from '../lib/internal-auth.mjs';
import { InternalApiError } from '../lib/internal-errors.mjs';

test('assertServiceKey throws when service key is missing in config', () => {
  const request = { headers: { 'x-service-key': 'abc' } };
  assert.throws(
    () => assertServiceKey(request, { serviceApiKey: '' }),
    (error) =>
      error instanceof InternalApiError &&
      error.statusCode === 503 &&
      error.code === 'SERVICE_KEY_NOT_CONFIGURED',
  );
});

test('assertServiceKey throws when request key is invalid', () => {
  const request = { headers: { 'x-service-key': 'wrong' } };
  assert.throws(
    () => assertServiceKey(request, { serviceApiKey: 'expected' }),
    (error) =>
      error instanceof InternalApiError &&
      error.statusCode === 401 &&
      error.code === 'INVALID_SERVICE_KEY',
  );
});

test('assertServiceKey passes for matching key', () => {
  const request = { headers: { 'x-service-key': 'expected' } };
  assert.doesNotThrow(() => assertServiceKey(request, { serviceApiKey: 'expected' }));
});

test('getRequestId uses existing header', () => {
  const request = { headers: { 'x-request-id': 'abc-123' } };
  assert.equal(getRequestId(request), 'abc-123');
});

test('getRequestId creates id when absent', () => {
  const request = { headers: {} };
  const id = getRequestId(request);
  assert.equal(typeof id, 'string');
  assert.ok(id.length > 0);
});

