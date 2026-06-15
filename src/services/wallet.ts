import { LoopSDK } from '@fivenorth/loop-sdk/server';
import type { Env } from '../config/index.js';
import { applyProxy, parseProxyList, maskProxy, type ProxyScope } from './proxy.js';

export interface Wallet {
  /** Loop SDK instance to pass as Temple's WALLET_ADAPTER. */
  loop: LoopSDK;
  partyId: string;
  /** Pay any gas the ledger says is due; returns the CC amount paid (0 when none). */
  payDueGasIfAny(): Promise<number>;
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
  const pool = [env.PROXY_URL, ...parseProxyList(env.PROXY_LIST)].filter((p): p is string => Boolean(p));
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
