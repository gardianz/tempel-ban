import 'dotenv/config';
import { resolve } from 'node:path';
import { initialize } from '@temple-digital-group/temple-canton-js';
import { loadConfig, loadEnv } from './config/index.js';
import { RateLimiter } from './core/ratelimiter.js';
import { TempleSdk } from './services/sdk.js';
import { TelegramNotifier } from './services/telegram.js';
import { loadStats, saveStats } from './services/stats-store.js';
import { Store } from './state/store.js';
import { Orchestrator } from './workers/orchestrator.js';
import { Dashboard } from './ui/dashboard.js';
import { installRateLimitObserver } from './services/ratelimit-observer.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const config = loadConfig();

  // 1. Init the Temple SDK with the API key ONLY. Trading (orders, book,
  // balances) uses X-API-Key over a DIRECT connection — no wallet, no proxy.
  // The Loop wallet + proxy are initialized lazily by the deposit manager, the
  // only thing that needs them (and the only thing a datacenter IP gets 403 on).
  await initialize({ API_KEY: env.TEMPLE_API_KEY, NETWORK: env.NETWORK });

  // 2. Wire core services around a shared store + rate limiter.
  const store = new Store();
  store.network = env.NETWORK;
  store.walletParty = env.LOOP_PARTY_ID;

  // Cumulative stats persist across restarts (volume, fills, deposits, etc.).
  const statsPath = resolve(process.cwd(), process.env.STATS_FILE ?? 'data/stats.json');
  store.restoreStats(loadStats(statsPath));
  const statsTimer = setInterval(() => saveStats(statsPath, store.statsSnapshot()), 30_000);
  statsTimer.unref?.();

  const limiter = new RateLimiter({
    ratePerMinute: config.ratePerMinute,
    maxRatePerMinute: config.maxRatePerMinute,
    minIntervalMs: config.minRequestIntervalMs,
    initialTokens: 10, // snappy startup for reads (orders gated separately)
  });
  const sdk = new TempleSdk(limiter, { network: env.NETWORK, apiKey: env.TEMPLE_API_KEY });

  // React only to a real Retry-After (429). The x-ratelimit-limit/remaining
  // headers are per-endpoint with an ambiguous window unit, so they aren't used
  // to throttle — order pacing comes from rate_limit_orders_per_minute instead.
  installRateLimitObserver((info) => {
    if (info.retryAfter !== undefined) limiter.pauseFor(info.retryAfter * 1000);
  });

  const telegram = new TelegramNotifier(env);
  telegram.attach(store, config.summaryIntervalMin);

  const orchestrator = new Orchestrator(sdk, env, store, config);

  // 4. Dashboard (headless-safe: only when attached to a TTY).
  const dashboard = process.stdout.isTTY ? new Dashboard(store) : undefined;
  dashboard?.start();

  // Headless: no dashboard to render events, so log them to stdout.
  if (!dashboard) {
    store.on('event', (e: { type: string; [k: string]: unknown }) => {
      const o = e.order as { side?: string; quantity?: number; symbol?: string; price?: number; orderId?: string; requestId?: string; settleMs?: number; estRewardCc?: number } | undefined;
      const id = o?.orderId ?? `req:${o?.requestId}`;
      if (e.type === 'order:placed') console.log(`PLACED ${o?.side} ${o?.quantity} ${o?.symbol} @ ${o?.price} (${id})`);
      else if (e.type === 'order:updated') console.log(`${String((e.order as { status?: string })?.status).toUpperCase()} ${o?.symbol} ${id}`);
      else if (e.type === 'order:settled') {
        const took = o?.settleMs !== undefined ? ` in ${Math.round(o.settleMs / 1000)}s` : '';
        const rwd = o?.estRewardCc !== undefined ? ` ~${o.estRewardCc.toFixed(4)} CC` : '';
        console.log(`SETTLED ${o?.side} ${o?.symbol} @ ${o?.price} (${id})${took}${rwd}`);
      }
      else if (e.type === 'order:cancelled') console.log(`CANCELLED ${o?.symbol} ${id}`);
      else if (e.type === 'deposit') console.log(`DEPOSIT ${e.amount} ${e.asset} ${e.ok ? 'ok' : 'FAIL'}${e.ccFee ? ` (gas ${e.ccFee} CC)` : ''}`);
      else if (e.type === 'info') console.log(`» [${e.scope}] ${e.message}`);
      else if (e.type === 'error') console.log(`[${e.scope}] ${e.message}`);
      else if (e.type === 'rate') console.log(`rate=${e.rate}/min 429=${e.count429}`);
    });
  }

  // 5. Periodic TRADING balance refresh (direct, no wallet). Wallet balances are
  // populated by the deposit manager once the wallet is lazily initialized.
  const balTimer = setInterval(async () => {
    try {
      store.tradingBalances = await sdk.getTradingBalance();
    } catch {
      /* surfaced elsewhere */
    }
  }, Math.max(10_000, config.pollIntervalSec * 1000));
  balTimer.unref?.();

  // 6. Graceful shutdown.
  const shutdown = () => {
    clearInterval(balTimer);
    clearInterval(statsTimer);
    saveStats(statsPath, store.statsSnapshot()); // flush final stats
    orchestrator.stop();
    telegram.stop();
    dashboard?.stop(false);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await orchestrator.start();
}

main().catch((e) => {
  console.error('FATAL:', e instanceof Error ? e.stack ?? e.message : e);
  process.exit(1);
});
