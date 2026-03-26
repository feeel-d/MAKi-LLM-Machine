import test from 'node:test';
import assert from 'node:assert/strict';
import { CapacityQueue } from '../lib/capacity-queue.mjs';

test('capacity queue serializes work that exceeds available units', async () => {
  const queue = new CapacityQueue({
    capacity: 2,
    maxPending: 4,
  });

  const order = [];

  const first = queue.enqueue(2, async () => {
    order.push('first-start');
    await new Promise((resolve) => setTimeout(resolve, 20));
    order.push('first-end');
  });

  const second = queue.enqueue(1, async () => {
    order.push('second-start');
    order.push('second-end');
  });

  await Promise.all([first, second]);

  assert.deepEqual(order, ['first-start', 'first-end', 'second-start', 'second-end']);
});
