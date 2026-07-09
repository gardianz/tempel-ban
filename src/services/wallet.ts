import { resolve } from 'node:path';
import { LoopSDK } from '@fivenorth/loop-sdk/server';
import type { Env } from '../config/index.js';
import { applyProxy, parseProxyList, loadProxyFile, maskProxy, type ProxyScope } from './proxy.js';

export interface Wallet {
  /** Loop SDK instance to pass as Temple's WALLET_ADAPTER. */
  loop: LoopSDK;
  partyId: string;
  /** Pay any gas the ledger says is due; returns the CC amount paid (0 when none). */
  payDueGasIfAny(): Promise<number>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * cantonloop.com's `/account/active-contracts` endpoint is tightly rate-limited:
 * a 2nd call within ~100ms of the 1st returns 429. But the Temple deposit flow
 * fires `getActiveContracts` 2–3× in a burst — getUtxoCount for CC, getUtxoCount
 * for the utility asset, then prepareDepositHoldings — all fetching the SAME
 * holdings. The later calls 429, the loop-sdk surfaces a bare "Failed to get
 * active contracts.", and the deposit reads that as "0 balance" → aborts with
 * "insufficient <asset>". Net effect: deposits silently never land even though
 * the wallet is funded.
 *
 * Harden the provider's getActiveContracts:
 *   1. short-TTL cache — collapses the burst of identical reads into ONE request;
 *   2. serialize + min-space real requests so back-to-back calls can't 429;
 *   3. retry a failed read with backoff (the loop-sdk hides the HTTP status, so
 *      treat the generic failure as the retryable 429 it almost always is).
 * Idempotent — guards against double-wrapping across lazy re-inits.
 */
function hardenLoopProvider(loop: LoopSDK): void {
  const provider = ((loop as unknown as { provider?: Record<string, unknown> }).provider ?? loop) as Record<
    string,
    unknown
  > & { __acHardened?: boolean };
  const orig = provider.getActiveContracts as ((p: unknown) => Promise<unknown>) | undefined;
  if (typeof orig !== 'function' || provider.__acHardened) return;
  const bound = orig.bind(provider);

  const MIN_GAP_MS = 1200; // spacing between real cantonloop active-contracts calls
  const CACHE_TTL_MS = 2500; // dedupe the deposit's identical burst reads
  const MAX_RETRY = 4;
  const cache = new Map<string, { at: number; value: unknown }>();
  let chain: Promise<unknown> = Promise.resolve();
  let lastAt = 0;

  provider.getActiveContracts = (params: unknown) => {
    const key = JSON.stringify(params ?? {});
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return Promise.resolve(hit.value);

    const run = chain.then(async () => {
      const cached = cache.get(key);
      if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;
      for (let attempt = 0; ; attempt++) {
        const wait = MIN_GAP_MS - (Date.now() - lastAt);
        if (wait > 0) await sleep(wait);
        lastAt = Date.now();
        try {
          const value = await bound(params);
          cache.set(key, { at: Date.now(), value });
          return value;
        } catch (e) {
          if (attempt >= MAX_RETRY) throw e;
          await sleep(MIN_GAP_MS * (attempt + 1) + 500); // back off then retry the 429
        }
      }
    });
    // Keep the chain flowing regardless of any single call's outcome.
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
  provider.__acHardened = true;
}

/**
 * Init the Loop SDK in server mode (local signing with the private key) and
 * authenticate. partyId is supplied via env (the signer needs it; it is not
 * derivable from the key alone without the on-ledger party hint).
 */
export async function initWallet(env: Env): Promise<Wallet> {
  const loop = new LoopSDK();
  loop.init({
    privateKey: env.LOOP_PRIVATE_KEY,
    partyId: env.LOOP_PARTY_ID,
    network: env.NETWORK,
  });
  await loop.authenticate();
  // Throttle + cache the rate-limited cantonloop active-contracts endpoint so the
  // deposit flow's burst reads don't 429 and abort the deposit as "0 balance".
  hardenLoopProvider(loop);

  return {
    loop,
    partyId: env.LOOP_PARTY_ID,
    async payDueGasIfAny(): Promise<number> {
      // PendingGasResponse: { pending, tracking_id?, gas_amount?, ... }
      const due = await loop.checkDueGas();
      if (due?.pending && due.tracking_id) {
        await loop.payGas(due.tracking_id);
        return Number(due.gas_amount) || 0;
      }
      return 0;
    },
  };
}

const withTimeout = <T>(p: Promise<T>, ms: number, label: string): Promise<T> =>
  Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);

/**
 * Init the wallet, rotating through the proxy pool until one authenticates.
 * Cantonloop's /pair/apikey blocks datacenter IPs (403) and individual proxies
 * die/rotate, so a single proxy is unreliable — try them in turn (fast-failing
 * dead ones via a per-attempt timeout). Returns the wallet + the working proxy,
 * which is left installed as the active dispatcher for the rest of the run.
 */
export async function initWalletWithProxyRotation(
  env: Env,
  scope: ProxyScope,
  perAttemptMs = 20_000,
): Promise<{ wallet: Wallet; proxy?: string }> {
  // Pool = PROXY_URL + PROXY_LIST (env) + proxy.txt (file, the easy way). The file
  // path defaults to ./proxy.txt, override with PROXY_FILE. All merged + deduped.
  const filePath = resolve(process.cwd(), env.PROXY_FILE ?? 'proxy.txt');
  const pool = [env.PROXY_URL, ...parseProxyList(env.PROXY_LIST), ...loadProxyFile(filePath)].filter(
    (p): p is string => Boolean(p),
  );
  const proxies = [...new Set(pool)];
  if (proxies.length === 0) {
    return { wallet: await initWallet(env), proxy: undefined };
  }

  let lastErr: unknown;
  for (let i = 0; i < proxies.length; i++) {
    const proxy = proxies[i]!;
    applyProxy(proxy, scope);
    try {
      const wallet = await withTimeout(initWallet(env), perAttemptMs, 'wallet auth');
      console.log(`wallet auth OK via proxy ${i + 1}/${proxies.length} (${maskProxy(proxy)})`);
      return { wallet, proxy };
    } catch (e) {
      lastErr = e;
      console.log(`proxy ${i + 1}/${proxies.length} (${maskProxy(proxy)}) auth failed: ${(e as Error).message} — trying next`);
    }
  }
  throw new Error(`all ${proxies.length} proxies failed wallet auth. last: ${(lastErr as Error)?.message}`);
}
