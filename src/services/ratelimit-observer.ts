import axios from 'axios';

export interface RateLimitInfo {
  limit?: number;
  remaining?: number;
  reset?: string;
  retryAfter?: number;
  path?: string;
  at: number;
}

/**
 * The Temple API returns `x-ratelimit-limit` / `x-ratelimit-remaining` (and
 * `retry-after` on 429) on every response, but the SDK discards them. This
 * installs an axios interceptor on the shared singleton to capture those headers
 * so the bot can SHOW the real per-window limit and throttle against it.
 */
let latest: RateLimitInfo = { at: 0 };
let onUpdate: ((info: RateLimitInfo) => void) | undefined;
let installed = false;

function parse(headers: Record<string, unknown> | undefined, url: string | undefined): RateLimitInfo | undefined {
  if (!headers) return undefined;
  const get = (k: string) => {
    const v = headers[k] ?? headers[k.toLowerCase()];
    return v === undefined ? undefined : String(v);
  };
  const limit = get('x-ratelimit-limit');
  const remaining = get('x-ratelimit-remaining');
  const reset = get('x-ratelimit-reset');
  const retry = get('retry-after');
  if (limit === undefined && remaining === undefined && retry === undefined) return undefined;
  return {
    limit: limit !== undefined ? Number(limit) : undefined,
    remaining: remaining !== undefined ? Number(remaining) : undefined,
    reset,
    retryAfter: retry !== undefined ? Number(retry) : undefined,
    path: url ? new URL(url, 'http://x').pathname : undefined,
    at: Date.now(),
  };
}

export function installRateLimitObserver(cb?: (info: RateLimitInfo) => void): void {
  onUpdate = cb;
  if (installed) return;
  installed = true;
  const handle = (headers: Record<string, unknown> | undefined, url: string | undefined) => {
    const info = parse(headers, url);
    if (!info) return;
    latest = info;
    onUpdate?.(info);
  };
  axios.interceptors.response.use(
    (res) => {
      handle(res.headers as Record<string, unknown>, res.config?.url);
      return res;
    },
    (err) => {
      handle(err?.response?.headers, err?.config?.url);
      return Promise.reject(err);
    },
  );
}

export function latestRateLimit(): RateLimitInfo {
  return latest;
}
