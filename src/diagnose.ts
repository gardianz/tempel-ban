import 'dotenv/config';
import * as temple from '@temple-digital-group/temple-canton-js';
import { initialize } from '@temple-digital-group/temple-canton-js';
import { loadConfig, loadEnv } from './config/index.js';
import { initWalletWithProxyRotation } from './services/wallet.js';
import { maskProxy } from './services/proxy.js';
import { installRateLimitObserver } from './services/ratelimit-observer.js';
import { splitPair } from './types.js';

/**
 * MAINNET-SAFE diagnostic. Verifies the real API response shapes before the
 * full bot is trusted with funds.
 *
 *   node --import tsx src/diagnose.ts            # Phase 1: READ-ONLY, places NOTHING
 *   node --import tsx src/diagnose.ts --canary   # Phase 2: ONE resting post_only order
 *                                                #          far from mid, then cancels it
 *
 * The canary order is placed at best_bid*0.5 (buy) or best_ask*2 (sell) with
 * post_only, so it cannot match/fill — it only rests so we can read its
 * order_id/request_id/status, then it is cancelled.
 */

const dump = (label: string, v: unknown) => {
  console.log(`\n=== ${label} ===`);
  console.log(JSON.stringify(v, null, 2));
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function argValue(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`${name}=`));
  return hit ? hit.split('=')[1] : undefined;
}

async function main() {
  const canary = process.argv.includes('--canary');
  const doDeposit = process.argv.includes('--deposit');
  const env = loadEnv();
  const config = loadConfig();
  const pair = config.pairs.find((p) => p.enabled) ?? config.pairs[0]!;
  const symbol = pair.symbol;

  const mode = [doDeposit && 'DEPOSIT', canary && 'CANARY', !doDeposit && !canary && 'READ-ONLY']
    .filter(Boolean)
    .join('+');
  console.log(`Network: ${env.NETWORK}  Pair: ${symbol}  Mode: ${mode}`);
  if (env.NETWORK === 'mainnet') console.log('⚠️  MAINNET — real funds.');

  installRateLimitObserver((info) => {
    console.log(
      `RATE-LIMIT [${info.path ?? '?'}]: limit=${info.limit ?? '?'} remaining=${info.remaining ?? '?'}` +
        (info.retryAfter !== undefined ? ` retry-after=${info.retryAfter}s` : ''),
    );
  });

  // Proxy rotation: try the pool until one authenticates (datacenter IPs get 403).
  const { wallet, proxy } = await initWalletWithProxyRotation(env, env.PROXY_SCOPE);
  console.log('Proxy     :', proxy ? maskProxy(proxy) : '(none)');
  await initialize({ API_KEY: env.TEMPLE_API_KEY, NETWORK: env.NETWORK, WALLET_ADAPTER: wallet.loop });

  // --- Phase 1: read-only shape capture ---
  dump('getSymbolConfig (raw)', await temple.getSymbolConfig(symbol));
  const book = await temple.getOrderBook(symbol, { levels: 1 });
  dump('getOrderBook (raw) — check {orderbook:{...}} vs flat, best_bid/ask vs bids/asks', book);
  dump('getTradingBalance (raw) — check balances[].asset/unlocked field names', await temple.getTradingBalance());
  dump('getUserBalances (raw) — wallet balances', await temple.getUserBalances(wallet.partyId));
  dump('getActiveOrders (raw) — check {orders:[...]} and whether each has request_id', await temple.getActiveOrders({ symbol }));

  // WS: log any user_order push to learn its real shape + status strings.
  try {
    temple.subscribeUserOrders((d: unknown) => dump('WS user_order push (raw)', d));
    temple.subscribeUserBalances((d: unknown) => dump('WS user_balance push (raw)', d));
  } catch (e) {
    console.log('WS subscribe failed:', (e as Error).message);
  }

  // --- Optional: deposit test (spend asset for the enabled pair's buy side) ---
  // Routes through OUR TempleSdk wrapper (the real bot path), NOT raw temple.deposit.
  // That is what exercises the silent-failure fix: a failed deposit resolves as
  // { error: "<msg>" } (error is a STRING) and the wrapper must THROW, not report
  // "sukses". A raw temple.deposit() call would hide that.
  if (doDeposit) {
    const { RateLimiter } = await import('./core/ratelimiter.js');
    const { TempleSdk } = await import('./services/sdk.js');
    const limiter = new RateLimiter({
      ratePerMinute: config.ratePerMinute,
      maxRatePerMinute: config.maxRatePerMinute,
      minIntervalMs: config.minRequestIntervalMs,
      initialTokens: 10,
    });
    const sdk = new TempleSdk(limiter, { network: env.NETWORK, apiKey: env.TEMPLE_API_KEY });

    const depositAsset = pair.symbol.split('/')[1]!; // quote (USDA) for a buy
    const amount = Number(argValue('--amount') ?? 15);
    console.log(`\nDEPOSIT TEST (via TempleSdk wrapper): ${amount} ${depositAsset} (wallet -> trading). Reserves 10 CC for fees.`);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 100) {
      throw new Error(`Refusing deposit: unsafe amount ${amount}. Pass --amount=N (<=100).`);
    }

    const unlockedOf = (bal: Record<string, { unlocked: number }>, asset: string): number => bal[asset]?.unlocked ?? 0;
    const before = await sdk.getTradingBalanceDetailed();
    const beforeAmt = unlockedOf(before, depositAsset);
    console.log(`trading ${depositAsset} unlocked BEFORE = ${beforeAmt}`);
    dump('wallet balances BEFORE', await sdk.getWalletBalances(wallet.partyId));

    let threw = false;
    try {
      await wallet.payDueGasIfAny();
      const res = await sdk.deposit(amount, depositAsset);
      console.log('deposit() returned WITHOUT throwing → wrapper treated as success:', JSON.stringify(res));
    } catch (e) {
      threw = true;
      console.log('deposit() THREW (fix working — no more silent sukses):', (e as Error).message);
    }

    // Deposit credits on-chain then the exchange picks it up — settlement lag can
    // be 30-60s. Poll up to 60s before declaring it didn't land.
    let landed = false;
    for (let i = 0; i < 20; i++) {
      await sleep(3000);
      const bal = await sdk.getTradingBalanceDetailed();
      const now = unlockedOf(bal, depositAsset);
      console.log(`poll ${i + 1}: trading ${depositAsset} unlocked = ${now} (Δ ${(now - beforeAmt).toFixed(6)})`);
      if (now >= beforeAmt + amount * 0.99) { landed = true; break; }
    }

    console.log('\n=== DEPOSIT VERDICT ===');
    if (landed && !threw) console.log(`✅ PASS: balance landed (+${amount} ${depositAsset}) and wrapper reported success.`);
    else if (!landed && threw) console.log('✅ PASS (failure path): deposit failed AND was surfaced as a throw — no silent false-sukses.');
    else if (landed && threw) console.log('⚠️ balance landed but wrapper threw — unexpected; inspect the error above.');
    else console.log('❌ FAIL: balance did NOT land and no throw — this is the silent-failure bug. Fix regressed.');
  }

  if (!canary) {
    console.log('\nNo canary order requested. Re-run with --canary to test order lifecycle.');
    await sleep(3000); // brief window for any WS pushes
    temple.disconnectWebSocket();
    return;
  }

  // --- Phase 2: canary order (resting, cannot fill) ---
  const ob = (book as { orderbook?: Record<string, unknown> }).orderbook ?? book;
  const bestBid = Number((ob as { best_bid?: unknown }).best_bid);
  const bestAsk = Number((ob as { best_ask?: unknown }).best_ask);
  const cfg = (await temple.getSymbolConfig(symbol)) as { minimum_quantity?: number; max_decimals?: number };
  const minQty = cfg.minimum_quantity ?? 0;
  const { base } = splitPair(symbol);

  // Buy far below bid so it rests without matching; post_only as a second guard.
  const side = 'buy' as const;
  const refPrice = Number.isFinite(bestBid) && bestBid > 0 ? bestBid : Number.isFinite(bestAsk) ? bestAsk : 1;
  const price = Number((refPrice * 0.5).toFixed(cfg.max_decimals ?? 6));
  // Use the configured per-pair token size; fall back to the exchange min, then
  // a tiny constant. NEVER default to 1 (would be ~1 whole CBTC).
  const quantity = pair.quantityPerOrder ?? (minQty > 0 ? minQty : 0.0001);
  const notional = quantity * refPrice; // approx USDA exposure if it somehow filled
  if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(notional) || notional > 50) {
    throw new Error(`Refusing canary: quantity ${quantity} ${base} ≈ ${notional.toFixed(2)} notional exceeds safety cap (50). Lower quantityPerOrder.`);
  }

  console.log(`\nCanary: ${side} ${quantity} ${base} @ ${price} (≈50% below bid, post_only, should REST not fill)`);
  const created = await temple.createOrderRequest({
    symbol, side, quantity, price, order_type: 'limit', order_subtype: 'post_only',
  });
  dump('createOrderRequest (raw) — capture request_id field name + type', created);

  const reqId = (created as { request_id?: unknown }).request_id;
  console.log(`request_id = ${String(reqId)}`);

  // Poll active orders to capture the request_id -> order_id join + status string.
  for (let i = 0; i < 6; i++) {
    await sleep(2000);
    const active = await temple.getActiveOrders({ symbol });
    const list = (active as { orders?: unknown[] }).orders ?? (Array.isArray(active) ? active : []);
    const mine = (list as Record<string, unknown>[]).find((o) => String(o.request_id) === String(reqId));
    if (mine) {
      dump(`getActiveOrders match (poll ${i + 1}) — order_id/request_id/status`, mine);
      const orderId = mine.order_id;
      console.log(`\nJOIN OK: request_id ${String(reqId)} -> order_id ${String(orderId)}, status="${String(mine.status)}"`);
      console.log('Cancelling canary...');
      dump('cancelOrder (raw)', await temple.cancelOrder(String(orderId)));
      break;
    }
    console.log(`poll ${i + 1}: order not visible yet (active has request_id? ${list.length ? Object.keys((list as any)[0]).includes('request_id') : 'n/a'})`);
    if (i === 5) {
      console.log('⚠️ Canary never appeared in getActiveOrders by request_id. Trying cancelAll as cleanup.');
      dump('cancelAllOrders (cleanup)', await temple.cancelAllOrders({ symbol }));
    }
  }

  await sleep(2000);
  temple.disconnectWebSocket();
  console.log('\nCanary done.');
}

main().catch((e) => {
  console.error('DIAGNOSE FATAL:', e instanceof Error ? (e.stack ?? e.message) : e);
  process.exit(1);
});
