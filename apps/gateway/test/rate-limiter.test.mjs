import test from 'node:test';
import assert from 'node:assert/strict';
import { RateLimiter } from '../lib/rate-limiter.mjs';

test('rate limiter blocks requests beyond burst limit', () => {
  const limiter = new RateLimiter({
    burstLimit: 2,
    burstWindowMs: 1_000,
    minuteLimit: 10,
  });

  assert.equal(limiter.allow('ip-1', 1), true);
  assert.equal(limiter.allow('ip-1', 1), true);
  assert.equal(limiter.allow('ip-1', 1), false);
});
