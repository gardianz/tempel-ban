import { describe, it, expect, beforeEach } from 'vitest';
import { RateLimiter } from '../src/core/ratelimiter.js';

/** Controllable clock + sleep that advances the clock instead of waiting. */
function makeHarness(start = 0) {
  let t = start;
  const clock = { now: () => t, advance: (ms: number) => (t += ms) };
  const sleep = (ms: number) => {
    t += ms;
    return Promise.resolve();
  };
  return { clock, sleep };
}

describe('RateLimiter AIMD', () => {
  it('increases additively after a success streak', () => {
    const { clock, sleep } = makeHarness();
    const rl = new RateLimiter({
      ratePerMinute: 30,
      maxRatePerMinute: 60,
      increaseEvery: 5,
      now: clock.now,
      sleep,
    });
    for (let i = 0; i < 4; i++) rl.onSuccess();
    expect(rl.currentRate).toBe(30);
    rl.onSuccess(); // 5th
    expect(rl.currentRate).toBe(31);
  });

  it('does not exceed maxRate', () => {
    const { clock, sleep } = makeHarness();
    const rl = new RateLimiter({ ratePerMinute: 59, maxRatePerMinute: 60, increaseEvery: 1, now: clock.now, sleep });
    rl.onSuccess();
    rl.onSuccess();
    rl.onSuccess();
    expect(rl.currentRate).toBe(60);
  });

  it('halves rate on 429 (multiplicative decrease)', () => {
    const { clock, sleep } = makeHarness();
    const rl = new RateLimiter({ ratePerMinute: 30, maxRatePerMinute: 60, now: clock.now, sleep });
    rl.on429();
    expect(rl.currentRate).toBe(15);
    rl.on429();
    expect(rl.currentRate).toBe(7);
  });

  it('never drops below minRate', () => {
    const { clock, sleep } = makeHarness();
    const rl = new RateLimiter({ ratePerMinute: 2, maxRatePerMinute: 60, minRatePerMinute: 1, now: clock.now, sleep });
    rl.on429();
    rl.on429();
    rl.on429();
    expect(rl.currentRate).toBe(1);
  });

  it('429 resets the success streak', () => {
    const { clock, sleep } = makeHarness();
    const rl = new RateLimiter({ ratePerMinute: 30, maxRatePerMinute: 60, increaseEvery: 3, now: clock.now, sleep });
    rl.onSuccess();
    rl.onSuccess();
    rl.on429(); // resets streak, rate -> 15
    rl.onSuccess();
    rl.onSuccess();
    expect(rl.currentRate).toBe(15); // streak restarted, no increase yet
  });
});

describe('RateLimiter token bucket', () => {
  it('consumes initial burst then blocks for refill', async () => {
    const { clock, sleep } = makeHarness();
    const rl = new RateLimiter({ ratePerMinute: 60, maxRatePerMinute: 60, now: clock.now, sleep });
    // 60/min => 1 token/sec, capacity 60. Drain the burst.
    for (let i = 0; i < 60; i++) await rl.acquire();
    expect(rl.availableTokens).toBeLessThan(1);
    const before = clock.now();
    await rl.acquire(); // must wait ~1000ms for one token
    expect(clock.now() - before).toBeGreaterThanOrEqual(1000);
  });

  it('spaces acquires by minIntervalMs (caps burst rate)', async () => {
    const { clock, sleep } = makeHarness();
    const rl = new RateLimiter({ ratePerMinute: 60, maxRatePerMinute: 60, minIntervalMs: 200, now: clock.now, sleep });
    await rl.acquire(); // t=0
    const t1 = clock.now();
    await rl.acquire(); // must wait >=200ms despite tokens available
    expect(clock.now() - t1).toBeGreaterThanOrEqual(200);
  });

  it('honors Retry-After pause', async () => {
    const { clock, sleep } = makeHarness();
    const rl = new RateLimiter({ ratePerMinute: 60, maxRatePerMinute: 60, now: clock.now, sleep });
    rl.on429(5000);
    const before = clock.now();
    await rl.acquire();
    expect(clock.now() - before).toBeGreaterThanOrEqual(5000);
  });
});
