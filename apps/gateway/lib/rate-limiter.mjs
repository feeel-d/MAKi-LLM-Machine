export class RateLimiter {
  constructor({
    burstLimit,
    burstWindowMs,
    minuteLimit,
  }) {
    this.burstLimit = burstLimit;
    this.burstWindowMs = burstWindowMs;
    this.minuteLimit = minuteLimit;
    this.requests = new Map();
  }

  allow(key, cost = 1) {
    const now = Date.now();
    const bucket = this.requests.get(key) ?? { burst: [], minute: [] };

    bucket.burst = bucket.burst.filter((entry) => now - entry.time < this.burstWindowMs);
    bucket.minute = bucket.minute.filter((entry) => now - entry.time < 60_000);

    const burstCount = bucket.burst.reduce((sum, entry) => sum + entry.cost, 0);
    const minuteCount = bucket.minute.reduce((sum, entry) => sum + entry.cost, 0);

    if (burstCount + cost > this.burstLimit || minuteCount + cost > this.minuteLimit) {
      this.requests.set(key, bucket);
      return false;
    }

    const stamp = { time: now, cost };
    bucket.burst.push(stamp);
    bucket.minute.push(stamp);
    this.requests.set(key, bucket);
    return true;
  }
}
