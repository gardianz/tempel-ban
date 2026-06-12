export interface RateLimiterOptions {
  /** Initial guess for requests/minute (default 30). */
  ratePerMinute: number;
  /** Upper AIMD bound. */
  maxRatePerMinute: number;
  /** Lower AIMD bound (default 1). */
  minRatePerMinute?: number;
  /** Successes in a row before the additive +1 increase (default 10). */
  increaseEvery?: number;
  /**
   * Minimum gap between acquires (ms). Spaces requests so a per-minute token
   * burst can't exceed a per-SECOND server cap. e.g. 150ms ≈ 6.6 req/s.
   */
  minIntervalMs?: number;
  /** Tokens available at construction (default 1). Higher = faster cold start. */
  initialTokens?: number;
  /** Injectable clock for tests. */
  now?: () => number;
  /** Injectable sleep for tests; resolves after ms. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * AIMD token-bucket rate limiter. The SDK does not expose its per-minute limit,
 * so we start at a guess and adapt: HTTP 429 halves the rate (multiplicative
 * decrease), sustained success nudges it back up by +1 (additive increase).
 *
 * Capacity == current rate (a one-minute burst). Tokens refill continuously at
 * rate/60000 per ms. `acquire()` waits until a token is available.
 */
export class RateLimiter {
  private rate: number;
  private maxRate: number;
  private readonly minRate: number;
  private readonly increaseEvery: number;
  private readonly minIntervalMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  private tokens: number;
  private lastRefill: number;
  private lastAcquireAt = 0;
  private successStreak = 0;
  /** Absolute timestamp before which acquire() must block (Retry-After). */
  private pausedUntil = 0;

  // stats
  private _acquired = 0;
  private _count429 = 0;

  constructor(opts: RateLimiterOptions) {
    this.rate = opts.ratePerMinute;
    this.maxRate = opts.maxRatePerMinute;
    this.minRate = opts.minRatePerMinute ?? 1;
    this.increaseEvery = opts.increaseEvery ?? 10;
    this.minIntervalMs = opts.minIntervalMs ?? 0;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? defaultSleep;
    // Start with a small token count, not a full bucket: a full bucket lets the
    // cold start fire `rate` requests instantly (a burst that trips per-second
    // caps). Order limiters use 1; the shared read limiter can start higher for a
    // snappy startup. Tokens then refill at the configured rate.
    this.tokens = Math.max(1, Math.min(opts.initialTokens ?? 1, this.rate));
    this.lastRefill = this.now();
  }

  private refill(): void {
    const t = this.now();
    const elapsed = t - this.lastRefill;
    if (elapsed > 0) {
      this.tokens = Math.min(this.rate, this.tokens + (elapsed * this.rate) / 60_000);
      this.lastRefill = t;
    }
  }

  /** Ms until the next token (and/or the end of a Retry-After pause). */
  private msUntilToken(): number {
    this.refill();
    const pauseWait = Math.max(0, this.pausedUntil - this.now());
    if (this.tokens >= 1) return pauseWait;
    const perToken = 60_000 / this.rate;
    const tokenWait = Math.ceil((1 - this.tokens) * perToken);
    return Math.max(pauseWait, tokenWait);
  }

  /** Block until a token is available AND the min spacing elapsed, then consume. */
  async acquire(): Promise<void> {
    // Loop because rate (and thus refill speed) can change while we wait.
    for (;;) {
      const tokenWait = this.msUntilToken();
      const spacingWait = Math.max(0, this.lastAcquireAt + this.minIntervalMs - this.now());
      const wait = Math.max(tokenWait, spacingWait);
      if (wait <= 0) {
        this.tokens -= 1;
        this._acquired += 1;
        this.lastAcquireAt = this.now();
        return;
      }
      await this.sleep(wait);
    }
  }

  /**
   * Adopt the server's advertised limit (from x-ratelimit-limit). Caps maxRate
   * and the current rate to it so we stop guessing and never exceed the real
   * per-window budget. Conservative: treats the limit as per-minute.
   */
  adoptServerLimit(limit: number): void {
    if (!Number.isFinite(limit) || limit <= 0) return;
    this.maxRate = limit;
    if (this.rate > limit) {
      this.rate = limit;
      if (this.tokens > limit) this.tokens = limit;
    }
  }

  /** Pause all acquires for `ms` (e.g. when the server says remaining is low). */
  pauseFor(ms: number): void {
    if (ms > 0) this.pausedUntil = Math.max(this.pausedUntil, this.now() + ms);
  }

  /** Report a successful call; drives the additive increase. */
  onSuccess(): void {
    this.successStreak += 1;
    if (this.successStreak >= this.increaseEvery) {
      this.successStreak = 0;
      this.rate = Math.min(this.maxRate, this.rate + 1);
    }
  }

  /** Report an HTTP 429; halves the rate and honors Retry-After. */
  on429(retryAfterMs?: number): void {
    this._count429 += 1;
    this.successStreak = 0;
    this.rate = Math.max(this.minRate, Math.floor(this.rate * 0.5));
    if (this.tokens > this.rate) this.tokens = this.rate;
    if (retryAfterMs && retryAfterMs > 0) {
      this.pausedUntil = Math.max(this.pausedUntil, this.now() + retryAfterMs);
    }
  }

  get currentRate(): number {
    return this.rate;
  }
  get availableTokens(): number {
    this.refill();
    return this.tokens;
  }
  get stats() {
    return { rate: this.rate, acquired: this._acquired, count429: this._count429 };
  }
}
