import * as temple from '@temple-digital-group/temple-canton-js';
import type { TempleSdk, OrderRow } from '../services/sdk.js';
import { initWalletWithProxyRotation, type Wallet } from '../services/wallet.js';
import { LiveOrderbook } from '../services/orderbook.js';
import type { Store } from '../state/store.js';
import type { Config, Env } from '../config/index.js';
import { PairWorker, type DepositManager } from './pair-worker.js';
import { shouldDeposit } from '../core/deposit-policy.js';
import { normalizeStatus, isKnownStatus, settlementBucket } from '../core/status.js';
import { floorToDecimals } from '../core/order-sizer.js';
import { splitPair, usdValue, type Side, type TrackedOrder } from '../types.js';

const CC_FEE_RESERVE = 10; // SDK always keeps 10 CC for gas.

/**
 * After a successful deposit, block another deposit for the SAME pair for this
 * long. A just-deposited amount takes a few seconds to reflect as `unlocked` in
 * the trading balance; without this guard the next tick still sees an empty
 * balance, can't place, drops to 0 live orders, and re-triggers a deposit — which
 * (the wallet's largest asset already gone) deposits the NEXT-largest asset too.
 * The cooldown ensures ONE deposit (the largest asset) per refill cycle.
 */
const DEPOSIT_COOLDOWN_MS = 60_000;

/**
 * Grace past an order's server-side expiry (expires_at = TTL + 30s) before
 * reconcile finalizes it as an expired ghost. Covers clock skew + reconcile
 * cadence so a still-live order is never expired early.
 */
const ORDER_EXPIRY_GRACE_MS = 120_000;

const num = (v: unknown): number => {
  const n = typeof v === 'string' ? Number(v) : (v as number);
  return typeof n === 'number' && !Number.isNaN(n) ? n : 0;
};

/**
 * Spawns one PairWorker per enabled pair and owns the shared deposit manager
 * (serialized so two pairs never spend the wallet at once). Also runs the
 * order-status pipeline: WebSocket user-order push + periodic getActiveOrders
 * reconcile, both feeding normalized statuses into the Store.
 */
export class Orchestrator implements DepositManager {
  private readonly workers: PairWorker[] = [];
  private depositChain: Promise<void> = Promise.resolve();
  /** Per-pair timestamp of the last SUCCESSFUL deposit (drives the cooldown). */
  private readonly lastDepositAt = new Map<string, number>();
  /** Per-pair last cooldown deadline we already logged (dedupes the skip note). */
  private readonly cooldownNotedFor = new Map<string, number>();
  private reconcileTimer?: NodeJS.Timeout;
  private wsUnsub?: () => void;
  private wsTradesUnsub?: () => void;
  private readonly liveBooks: LiveOrderbook[] = [];
  private stopped = false;
  /** Lazily initialized (proxy + Loop auth) on the first deposit only. */
  private wallet?: Wallet;
  private walletInit?: Promise<Wallet>;

  constructor(
    private readonly sdk: TempleSdk,
    private readonly env: Env,
    private readonly store: Store,
    private readonly config: Config,
  ) {}

  async start(): Promise<void> {
    // No wallet/proxy/onboarding here — trading needs only the API key. The
    // wallet (and proxy) come up lazily on the first deposit.
    this.store.note('startup', `bot start — network ${this.store.network}, mode trading langsung (wallet menyusul saat deposit pertama)`);
    const enabledPairs = this.config.pairs.filter((p) => p.enabled).map((p) => p.symbol);
    this.store.note('startup', `pair aktif: ${enabledPairs.join(', ') || '(tidak ada)'}`);
    // Adopt any orders already open on the exchange (e.g. from a previous run)
    // BEFORE workers start, so they resume the right phase and wait for those
    // orders to settle instead of trading blind.
    await this.adoptExistingOrders();
    await this.loadProfile();
    try {
      this.store.oraclePrices = await this.sdk.getOracle(); // prime USD prices before trading
      this.store.note('startup', 'harga oracle dimuat (untuk pilih side & nilai USD)');
    } catch {
      /* refreshed each reconcile */
    }
    // Show current Temple trading balances at boot (the funds we trade from).
    try {
      const detailed = await this.sdk.getTradingBalanceDetailed();
      this.store.tradingDetailed = detailed;
      this.store.tradingBalances = Object.fromEntries(Object.entries(detailed).map(([k, v]) => [k, v.unlocked]));
      const summary = Object.entries(detailed)
        .filter(([, v]) => v.unlocked + v.locked > 0)
        .map(([k, v]) => `${k} ${(v.unlocked + v.locked).toFixed(4)}`)
        .join(', ');
      this.store.note('startup', `cek saldo Temple (trading): ${summary || 'kosong'}`);
    } catch {
      /* refreshed each reconcile */
    }
    // Bring the wallet up in the BACKGROUND (proxy auth) so its balance shows on
    // the dashboard and deposits are ready — without blocking trading startup.
    void this.ensureWallet().catch(() => {});
    this.subscribeUserOrders();
    this.startReconciler();

    for (const pair of this.config.pairs) {
      if (!pair.enabled) continue;
      // Live WS top-of-book → real-time best bid/ask (no REST polling lag).
      const lob = new LiveOrderbook(pair.symbol, (top) => {
        this.store.liveBooks[pair.symbol] = {
          bestBid: top.bestBid,
          bestAsk: top.bestAsk,
          bids: top.bids,
          asks: top.asks,
          bidLevels: top.bidLevels,
          askLevels: top.askLevels,
          ts: top.ts,
        };
      });
      this.liveBooks.push(lob);
      const w = new PairWorker(this.sdk, this.store, this.config, pair, this);
      this.workers.push(w);
      void w.start(); // each runs its own loop
    }
  }

  /** Load active orders AND unsettled trades from the exchange so we resume cleanly. */
  private async adoptExistingOrders(): Promise<void> {
    const enabled = new Set(this.config.pairs.filter((p) => p.enabled).map((p) => p.symbol));
    for (const sym of enabled) this.store.initPair(sym, 'auto');
    try {
      // 1. Resting orders → pending.
      const active = await this.sdk.getActiveOrders();
      let placed = 0;
      const seenOrderIds = new Set<string>();
      for (const a of active) {
        const reqId = a.request_id !== undefined ? String(a.request_id) : undefined;
        const symbol = a.symbol ?? '';
        if (!reqId || !enabled.has(symbol)) continue;
        const orderId = a.order_id ? String(a.order_id) : undefined;
        if (orderId) seenOrderIds.add(orderId);
        this.store.addOrder({
          requestId: reqId,
          orderId,
          symbol,
          side: (a.side === 'sell' ? 'sell' : 'buy') as Side,
          price: Number(a.price) || 0,
          quantity: Number(a.quantity) || 0,
          status: 'placed',
          placedAt: Date.now(),
          updatedAt: Date.now(),
        }, true);
        placed += 1;
      }

      // 2. Recent fills not yet settled → adopt in their settlement bucket
      //    (pending/settling) so they show on the dashboard and the ping-pong
      //    gate waits for them.
      let unsettled = 0;
      try {
        const trades = await this.sdk.getRecentUserTrades(150);
        const byOrder = new Map<string, { side: string; price: number; qty: number; statuses: string[] }>();
        for (const t of trades) {
          const oid = t.order_id;
          if (!oid || seenOrderIds.has(oid)) continue; // skip resting (already pending)
          let e = byOrder.get(oid);
          if (!e) byOrder.set(oid, (e = { side: (t.side ?? 'buy').toLowerCase(), price: num(t.price), qty: 0, statuses: [] }));
          e.qty += num(t.quantity);
          e.statuses.push((t.status ?? '').toLowerCase());
        }
        for (const [oid, e] of byOrder) {
          const bucket = settlementBucket(e.statuses); // pending | settling | settled
          if (bucket === 'settled') continue; // already settled — don't track
          this.store.addOrder({
            requestId: `t:${oid}`, // synthetic key for a fill we didn't place this session
            orderId: oid,
            symbol: this.config.pairs.find((p) => p.enabled)?.symbol ?? '',
            side: (e.side === 'sell' ? 'sell' : 'buy') as Side,
            price: e.price,
            quantity: e.qty,
            status: bucket, // pending or settling
            placedAt: Date.now(),
            updatedAt: Date.now(),
          }, true);
          unsettled += 1;
        }
      } catch {
        /* trades optional at startup */
      }
      this.store.note('startup', `adopsi order lama: ${placed} resting + ${unsettled} terisi-belum-settle`);
    } catch (e) {
      this.store.recordError('startup', `adoptExistingOrders failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  stop(): void {
    this.stopped = true;
    for (const w of this.workers) w.stop();
    for (const lob of this.liveBooks) lob.close();
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    this.wsUnsub?.();
    this.wsTradesUnsub?.();
    temple.disconnectWebSocket();
  }

  /**
   * Lazily bring up the Loop wallet (proxy rotation + auth + setWalletAdapter +
   * onboarding) the first time a deposit needs it. Trading never calls this.
   */
  private ensureWallet(): Promise<Wallet> {
    if (this.wallet) return Promise.resolve(this.wallet);
    if (this.walletInit) return this.walletInit;
    this.walletInit = (async () => {
      this.store.note('wallet', 'inisialisasi Loop wallet + proxy untuk deposit…');
      const { wallet, proxy } = await initWalletWithProxyRotation(this.env, this.env.PROXY_SCOPE);
      temple.setWalletAdapter(wallet.loop);
      this.wallet = wallet;
      this.store.walletParty = wallet.partyId;
      this.store.note('wallet', `wallet siap (proxy ${proxy ? 'on' : 'off'})`);
      // Show the Loop wallet balance the moment it comes up.
      try {
        const wb = await this.sdk.getWalletBalances(wallet.partyId);
        this.store.walletBalances = wb;
        const line = Object.entries(wb).filter(([, v]) => Number(v) > 0).map(([k, v]) => `${k} ${Number(v).toFixed(4)}`).join(', ');
        this.store.note('wallet', `cek saldo wallet Loop: ${line || 'kosong'}`);
      } catch {
        /* non-fatal */
      }
      // Ensure the delegation exists (one-time).
      const onboarded = await this.sdk.isOnboarded(wallet.partyId);
      if (!onboarded) {
        const res = await this.sdk.onboard(wallet.partyId);
        if (res.warning) this.store.recordError('onboard', res.warning);
      }
      return wallet;
    })();
    return this.walletInit;
  }

  // --- status pipeline ---

  private subscribeUserOrders(): void {
    // Order status (placed/filled/canceled). NOTE: this feed's `quantity`
    // (remaining) is settlement-adjusted and unreliable for fill amount — the
    // fill qty comes from the trades feed (subscribeUserTrades + reconcile).
    this.wsUnsub = temple.subscribeUserOrders((data: unknown) => {
      const o = data as { order_id?: string; request_id?: string | number; status?: string };
      if (!o.status) return;
      let requestId: string | undefined = o.request_id !== undefined ? String(o.request_id) : undefined;
      if (!requestId && o.order_id) requestId = this.store.findRequestIdByOrderId(String(o.order_id));
      if (requestId) this.applyStatus(requestId, o.status);
    });

    // Real-time FILL amount: each user trade adds its base qty to the matching
    // tracked order (by order_id), so the per-order fill bar advances the instant
    // a fill lands instead of waiting for the reconcile. Volume on a WS-driven
    // settle then reflects the real filled amount.
    // subscribeUserTrades exists at runtime but is missing from the SDK's .d.ts.
    const subscribeUserTrades = (temple as unknown as {
      subscribeUserTrades: (cb: (d: unknown) => void) => (() => void);
    }).subscribeUserTrades;
    this.wsTradesUnsub = subscribeUserTrades((data: unknown) => {
      const t = data as { order_id?: string; quantity?: string | number };
      if (!t.order_id) return;
      const reqId = this.store.findRequestIdByOrderId(String(t.order_id));
      if (!reqId) return;
      const o = this.store.orders.get(reqId);
      if (o) o.filledQuantity = Math.min(o.quantity, (o.filledQuantity ?? 0) + num(t.quantity));
    });
  }

  /** Normalize + apply a raw status (by request_id), flagging unknown values. */
  private applyStatus(requestId: string, raw: string): void {
    if (!isKnownStatus(raw)) {
      this.store.recordError('status', `unknown order status "${raw}" -> treated as pending (calibrate normalizeStatus)`);
    }
    this.store.updateOrderStatus(requestId, normalizeStatus(raw));
  }

  private startReconciler(): void {
    this.reconcileTimer = setInterval(() => void this.reconcile(), this.config.pollIntervalSec * 1000);
    if (this.reconcileTimer.unref) this.reconcileTimer.unref();
  }

  /**
   * Re-derive every tracked order's status from the AUTHORITATIVE by-request
   * lookup (POST /orders/by-request), no longer from a fragile "gone from book +
   * match a trade by side/price/ts" heuristic:
   *   - active (open/partially_filled) → placed (resolves its real order_id)
   *   - inactive canceled/expired      → cancelled (no 2-minute grace guessing)
   *   - inactive filled                → settlement bucket from that order's trades
   * The trades feed is used ONLY for the pending→settling→settled progression of
   * filled orders (order status doesn't expose settlement). Adopted `t:` fills
   * (no request_id) still settle via their trades.
   */
  private async reconcile(): Promise<void> {
    if (this.stopped) return;
    try {
      const tracked = [...this.store.orders.values()];

      // 1. Authoritative order status for our tracked request_ids (numeric only;
      //    synthetic adopted `t:oid` keys have no request_id → trades path below).
      const numericIds = tracked.map((o) => o.requestId).filter((id) => /^\d+$/.test(id));
      const byReq = new Map<string, OrderRow>();
      let byReqOk = true; // gate the expiry cleanup — never finalize on a failed lookup
      if (numericIds.length > 0) {
        try {
          const { active, inactive } = await this.sdk.getOrdersByRequestIds(numericIds);
          for (const r of [...active, ...inactive]) if (r.requestId) byReq.set(r.requestId, r);
        } catch (e) {
          byReqOk = false;
          this.store.recordError('reconcile', `by-request failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      const now = Date.now();
      const ttlMs = this.config.orderTtlMinutes * 60_000;

      // 2. Trades index (order_id -> trade statuses) for the settlement progression.
      let trades: Awaited<ReturnType<TempleSdk['getRecentUserTrades']>> = [];
      try {
        trades = await this.sdk.getRecentUserTrades(150);
      } catch (e) {
        this.store.recordError('trades', e instanceof Error ? e.message : String(e));
      }
      // order_id → trade settlement statuses AND summed filled base qty. The
      // trades feed is the ONLY reliable fill source: by-request's `quantity`
      // (remaining) is settlement-adjusted and stays = original for a FILLED maker
      // order (status "filled", remaining=original), so original−remaining gives 0.
      const tradesByOrderId = new Map<string, string[]>();
      const filledByOrderId = new Map<string, number>();
      for (const t of trades) {
        if (!t.order_id) continue;
        let arr = tradesByOrderId.get(t.order_id);
        if (!arr) tradesByOrderId.set(t.order_id, (arr = []));
        arr.push((t.status ?? '').toLowerCase());
        filledByOrderId.set(t.order_id, (filledByOrderId.get(t.order_id) ?? 0) + num(t.quantity));
      }

      for (const o of tracked) {
        const row = byReq.get(o.requestId);
        if (row?.orderId) this.store.resolveOrderId(o.requestId, row.orderId);
        // Filled base qty from the trades feed (monotonic: fills only grow, and the
        // 150-trade window can drop old rows). Drives the per-order fill bar + volume.
        if (o.orderId) {
          const filled = filledByOrderId.get(o.orderId);
          // Authoritative when trades are present (corrects any WS interim drift);
          // keep the last value when they've aged out of the window (never drop).
          if (filled !== undefined) o.filledQuantity = Math.min(o.quantity, filled);
        }
        if (row) {
          const norm = normalizeStatus(row.status ?? '');
          if (norm === 'cancelled') {
            // Authoritative canceled/expired. If it caught fills before expiring,
            // settle so that volume counts; only a truly-unfilled order is dropped.
            if ((o.filledQuantity ?? 0) > 0) this.store.updateOrderStatus(o.requestId, 'settled');
            else this.store.markCancelled(o.requestId);
            continue;
          }
          if (norm === 'placed') {
            if (o.status !== 'placed') this.store.updateOrderStatus(o.requestId, 'placed');
            continue;
          }
          // Order filled → settlement bucket from its trades (default settling
          // until they confirm settled). Never settle without proof.
          const st = o.orderId ? tradesByOrderId.get(o.orderId) : undefined;
          this.store.updateOrderStatus(o.requestId, st && st.length > 0 ? settlementBucket(st) : 'settling');
          continue;
        }
        // No by-request row: adopted `t:` fill (settle via trades) or a transient
        // lookup miss → progress by trades if possible, else leave as-is (no guess).
        const st = o.orderId ? tradesByOrderId.get(o.orderId) : undefined;
        if (st && st.length > 0) {
          this.store.updateOrderStatus(o.requestId, settlementBucket(st));
          continue;
        }
        // Expired-ghost cleanup. Every limit order is placed with expires_at =
        // TTL+30s, so once an order is well past that AND the server no longer
        // lists it (no by-request row, no recent trades), it has expired
        // server-side. Finalize it so it doesn't linger forever as a `placed`
        // ghost — the bug behind the old re-quote 404 loop. Settle if it caught
        // fills (counts the volume that was never recorded while it was stuck),
        // else drop it. Only when the by-request lookup actually succeeded.
        if (byReqOk && o.status === 'placed' && now - o.placedAt > ttlMs + ORDER_EXPIRY_GRACE_MS) {
          if ((o.filledQuantity ?? 0) > 0) this.store.updateOrderStatus(o.requestId, 'settled');
          else this.store.markCancelled(o.requestId);
        }
      }

      // Balance detail for the dashboard (NOT used to infer settlement).
      const detailed = await this.sdk.getTradingBalanceDetailed();
      this.store.tradingDetailed = detailed;
      this.store.tradingBalances = Object.fromEntries(Object.entries(detailed).map(([k, v]) => [k, v.unlocked]));

      // (B) Health guard + (C) rewards — cheap, refreshed periodically.
      await this.refreshStatusAndRewards();
    } catch (e) {
      this.store.recordError('reconcile', e instanceof Error ? e.message : String(e));
    } finally {
      const s = this.sdk.rateStats;
      this.store.setRate(s.rate, s.count429);
    }
  }

  private async loadProfile(): Promise<void> {
    try {
      const p = await this.sdk.getProfile();
      this.store.maxLimitOrders = p.max_limit_orders;
      this.store.makerFees = p.maker_fees;
      this.store.takerFees = p.taker_fees;
      this.store.note('profile', `max order limit=${p.max_limit_orders}, fee maker=${p.maker_fees} taker=${p.taker_fees}`);
    } catch {
      // getProfile isn't exposed on the api.* host (404). Non-fatal: "auto"
      // maxOpenOrders falls back to a sane default cap.
      this.store.note('profile', 'profile tidak tersedia di api host — auto order cap pakai default (100)');
    }
  }

  private reconcileTick = 0;
  /** Health guard (every tick) + rewards (every ~10th tick). */
  private async refreshStatusAndRewards(): Promise<void> {
    try {
      const s = await this.sdk.getStatus();
      this.store.tradingHalted = Boolean(s.killswitch || s.tradingPaused);
    } catch {
      /* leave previous flag */
    }
    // Oracle USD prices drive side selection + deposit-asset choice.
    try {
      this.store.oraclePrices = await this.sdk.getOracle();
    } catch {
      /* keep previous */
    }
    if (this.reconcileTick++ % 10 === 0) {
      try {
        const r = await this.sdk.getRewards();
        this.store.ccEarnedTotal = r.rewards?.total_canton_coin_earned;
        this.store.ccEarned30d = r.rewards?.canton_coin_earned_30d;
        this.store.volume30d = r.rewards?.volume_30d;
      } catch {
        /* ignore */
      }
      // Wallet (Loop) balance for the dashboard — only once the wallet is up.
      if (this.wallet) {
        try {
          this.store.walletBalances = await this.sdk.getWalletBalances(this.wallet.partyId);
        } catch {
          /* ignore */
        }
      }
    }
  }

  // --- DepositManager (serialized across pairs) ---

  requestDeposit(symbol: string): Promise<void> {
    // Chain deposits so only one runs at a time (no double-spend / gas races).
    this.depositChain = this.depositChain.then(() => this.maybeDeposit(symbol));
    return this.depositChain;
  }

  /**
   * User-triggered withdrawal (CLI `withdraw` / Telegram `/withdraw`). Serialized
   * on the SAME chain as deposits so the wallet is never used by two flows at
   * once. Brings up the wallet lazily (proxy). Returns a human status string.
   */
  requestWithdraw(asset: string, amount: number): Promise<string> {
    const run = this.depositChain.then(() => this.doWithdraw(asset, amount));
    // Keep the (void) chain alive regardless of this call's result/throw.
    this.depositChain = run.then(() => undefined, () => undefined);
    return run;
  }

  private async doWithdraw(asset: string, amount: number): Promise<string> {
    if (!Number.isFinite(amount) || amount <= 0) return `jumlah tidak valid: ${amount}`;
    let walletApi: Wallet;
    try {
      walletApi = await this.ensureWallet();
    } catch (e) {
      return `wallet gagal init: ${e instanceof Error ? e.message : String(e)}`;
    }
    try {
      this.store.note('withdraw', `tarik ${amount} ${asset} dari trading → wallet…`);
      await walletApi.payDueGasIfAny().catch(() => 0); // clear any pending ledger gas first
      await this.sdk.withdraw(asset, amount);
      const gas = await walletApi.payDueGasIfAny().catch(() => 0);
      const msg = `withdraw ${amount} ${asset} sukses${gas > 0 ? ` (gas ${gas} CC)` : ''}`;
      this.store.note('withdraw', msg);
      return `✔ ${msg}`;
    } catch (e) {
      const emsg = e instanceof Error ? e.message : String(e);
      this.store.recordError('withdraw', emsg);
      return `⚠️ withdraw ${amount} ${asset} GAGAL: ${emsg}`;
    }
  }

  /**
   * Deposit the wallet's LARGEST-USD relevant asset (base or quote of the pair).
   * That asset is whatever this trading cycle's fills accrued into the wallet, so
   * depositing it funds the next side automatically.
   */
  private async maybeDeposit(symbol: string): Promise<void> {
    if (this.stopped || this.store.userPaused) return;
    const orders = this.store.ordersForPair(symbol);
    if (!shouldDeposit({ orders, remainingThresholdN: this.config.remainingThresholdN })) return;

    // Cooldown: one deposit (the largest asset) per refill cycle. A just-deposited
    // amount hasn't reflected in the trading balance yet, so skip re-depositing
    // (which would pick the next-largest asset) until the funds land.
    const last = this.lastDepositAt.get(symbol) ?? 0;
    const sinceLast = Date.now() - last;
    if (sinceLast < DEPOSIT_COOLDOWN_MS) {
      if (this.cooldownNotedFor.get(symbol) !== last) {
        this.cooldownNotedFor.set(symbol, last);
        this.store.note('deposit', `${symbol}: baru saja deposit — tunggu dana masuk ke trading (~${Math.round((DEPOSIT_COOLDOWN_MS - sinceLast) / 1000)}s), skip biar tak deposit dobel`);
      }
      return;
    }

    // First deposit brings up the wallet + proxy (lazily). If it fails (all
    // proxies down), trading keeps running; we just skip the refill this round.
    let walletApi: Wallet;
    try {
      walletApi = await this.ensureWallet();
    } catch (e) {
      this.store.recordError('deposit', `wallet init failed, skipping deposit: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }

    const wallet = await this.sdk.getWalletBalances(walletApi.partyId);
    this.store.walletBalances = wallet;
    const walletCc = wallet['CC'] ?? 0;

    // Gas guard: stop depositing once wallet CC drops below the configured floor.
    const ccFloor = Math.max(this.config.minWalletCc, CC_FEE_RESERVE);
    if (walletCc < ccFloor) {
      this.store.patchPair(symbol, { note: `deposit paused: wallet CC ${walletCc} < ${ccFloor}` });
      this.store.recordError('deposit', `paused — wallet CC ${walletCc} below floor ${ccFloor} (gas guard)`);
      return;
    }

    // Pick the largest-USD asset among the pair's base/quote in the wallet.
    const { base, quote } = splitPair(symbol);
    const px = this.store.oraclePrices;
    let asset = '';
    let bestUsd = 0;
    for (const a of [base, quote]) {
      const reserve = this.config.walletReserve[a] ?? 0;
      const feeReserve = a === 'CC' ? CC_FEE_RESERVE : 0;
      const avail = (wallet[a] ?? 0) - reserve - feeReserve;
      if (avail <= 0) continue;
      const usd = usdValue(a, avail, px);
      if (usd > bestUsd) {
        bestUsd = usd;
        asset = a;
      }
    }
    if (!asset) {
      this.store.patchPair(symbol, { note: 'no wallet funds (base/quote) to deposit' });
      return;
    }

    const reserve = this.config.walletReserve[asset] ?? 0;
    const feeReserve = asset === 'CC' ? CC_FEE_RESERVE : 0;
    const amount = floorToDecimals((wallet[asset] ?? 0) - reserve - feeReserve, 6);
    if (amount <= 0) {
      this.store.patchPair(symbol, { note: `no wallet funds to deposit ${asset}` });
      return;
    }

    try {
      this.store.note('deposit', `deposit ${amount} ${asset} ($${bestUsd.toFixed(2)}) dari wallet → trading`);
      const ccFee = await walletApi.payDueGasIfAny();
      if (ccFee > 0) this.store.note('deposit', `bayar gas ledger ${ccFee} CC sebelum deposit`);
      await this.sdk.deposit(amount, asset);
      this.store.recordDeposit(asset, amount, true, ccFee);
      this.lastDepositAt.set(symbol, Date.now()); // start the cooldown (one deposit/refill)
      const t = this.store.depositTotals();
      this.store.note(
        'deposit',
        `deposit ${asset} sukses. Hari ini ${(t.today[asset] ?? 0).toFixed(4)} ${asset} (fee ${t.todayCcFee.toFixed(2)} CC) | bulan ini ${(t.month[asset] ?? 0).toFixed(4)} ${asset} (fee ${t.monthCcFee.toFixed(2)} CC)`,
      );
    } catch (e) {
      this.store.recordDeposit(asset, amount, false);
      this.store.recordError('deposit', e instanceof Error ? e.message : String(e));
    }
  }
}
