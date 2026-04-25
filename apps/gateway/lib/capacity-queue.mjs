export class CapacityQueue {
  constructor({ capacity, maxPending }) {
    this.capacity = capacity;
    this.maxPending = maxPending;
    this.inUse = 0;
    this.pending = [];
  }

  enqueue(units, task) {
    if (units > this.capacity) {
      return Promise.reject(new Error('Requested capacity exceeds queue limit.'));
    }

    if (this.pending.length >= this.maxPending) {
      return Promise.reject(new Error('Queue is full.'));
    }

    return new Promise((resolve, reject) => {
      this.pending.push({ units, task, resolve, reject });
      this.#drain();
    });
  }

  #drain() {
    for (let index = 0; index < this.pending.length; index += 1) {
      const item = this.pending[index];
      if (this.inUse + item.units > this.capacity) {
        continue;
      }

      this.pending.splice(index, 1);
      this.inUse += item.units;
      index -= 1;

      Promise.resolve()
        .then(item.task)
        .then(item.resolve, item.reject)
        .finally(() => {
          this.inUse -= item.units;
          this.#drain();
        });
    }
  }

  /** title-from-text 디버그: GPU 슬롯(동시 inference)·대기 큐 압박 상관 */
  getStats() {
    return {
      capacity: this.capacity,
      maxPending: this.maxPending,
      inUse: this.inUse,
      pendingJobs: this.pending.length,
      pendingUnits: this.pending.reduce((sum, item) => sum + item.units, 0),
    };
  }
}
