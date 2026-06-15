import * as temple from '@temple-digital-group/temple-canton-js';
import type { TempleSdk } from '../services/sdk.js';
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
  private reconcileTimer?: NodeJS.Timeout;
  private wsUnsub?: () => void;
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
        this.store.liveBooks[pair.symbol] = { bestBid: top.bestBid, bestAsk: top.bestAsk, bids: top.bids, asks: top.asks, ts: top.ts };
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
    this.wsUnsub = temple.subscribeUserOrders((data: unknown) => {
      const o = data as { order_id?: string; request_id?: string | number; status?: string };
      if (!o.status) return;
      // Prefer request_id (our tracking key). Fall back to order_id -> request_id.
      let requestId: string | undefined =
        o.request_id !== undefined ? String(o.request_id) : undefined;
      if (!requestId && o.order_id) requestId = this.store.findRequestIdByOrderId(String(o.order_id));
      if (requestId) this.applyStatus(requestId, o.status);
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
   * Re-derive every tracked order's status from two authoritative sources each
   * tick (no fragile "gone from book = settling" guess that breaks on a transient
   * getActiveOrders miss):
   *   - in the ACTIVE book          → pending (still resting)
   *   - has a TRADE (proof of fill) → settling, or settled when ALL its trades settle
   *   - not active, no trade, past TTL+grace → expired/cancelled → settled
   * Matches the reference bot: fills come from /api/trading/trades, not absence.
   */
  private async reconcile(): Promise<void> {
    if (this.stopped) return;
    try {
      const active = await this.sdk.getActiveOrders();
      const activeReqIds = new Set<string>();
      for (const a of active) {
        const reqId = a.request_id !== undefined ? String(a.request_id) : undefined;
        const orderId = a.order_id ? String(a.order_id) : undefined;
        if (!reqId) {
          if (orderId) this.warnNoRequestId(orderId);
          continue;
        }
        activeReqIds.add(reqId);
        if (orderId) this.store.resolveOrderId(reqId, orderId);
      }

      // Trades index. CRITICAL: order_id match is exact (a trade belongs to one
      // order); the side+price FALLBACK must also require the trade to be NEWER
      // than the order — otherwise it matches ancient trades at the same price
      // (there are tens of thousands) and false-settles everything (worse on
      // restart). Same guard as the reference bot (trade_ts >= placed_at - 5s).
      type TInfo = { status: string; qty: number; ts: number; side: string; price: number; orderId?: string };
      let trades: Awaited<ReturnType<TempleSdk['getRecentUserTrades']>> = [];
      try {
        trades = await this.sdk.getRecentUserTrades(150);
      } catch (e) {
        this.store.recordError('trades', e instanceof Error ? e.message : String(e));
      }
      const tinfos: (TInfo & { side: string; price: number; orderId?: string })[] = trades.map((t) => ({
        status: (t.status ?? '').toLowerCase(),
        qty: num(t.quantity),
        ts: t.created_at ? Date.parse(t.created_at) : 0,
        side: (t.side ?? '').toLowerCase(),
        price: num(t.price),
        orderId: t.order_id,
      }));
      const byOrderId = new Map<string, TInfo[]>();
      for (const t of tinfos) {
        if (!t.orderId) continue;
        let arr = byOrderId.get(t.orderId);
        if (!arr) byOrderId.set(t.orderId, (arr = []));
        arr.push(t);
      }
      // order_ids already owned by a tracked order — never claim these for another.
      const claimed = new Set<string>();
      for (const o of this.store.orders.values()) if (o.orderId) claimed.add(o.orderId);

      // 1:1 claim: assign an unclaimed trade's order_id to a tracked order without
      // one, matched by side + price + (trade newer than the order). Fixes the
      // shared-price ambiguity that previously mis-labelled FILLS as cancelled.
      const claimOrderId = (o: { side: string; price: number; placedAt: number }): string | undefined => {
        for (const [oid, list] of byOrderId) {
          if (claimed.has(oid)) continue;
          const t = list[0];
          if (!t) continue;
          if (t.side === o.side && Math.abs(t.price - o.price) <= Math.max(o.price * 1e-4, 1e-8) && t.ts >= o.placedAt - 5_000) {
            claimed.add(oid);
            return oid;
          }
        }
        return undefined;
      };

      const now = Date.now();
      const CANCEL_GRACE = Math.max(this.config.orderTtlMinutes * 60_000, 120_000); // long: real cancel/expire only
      for (const o of [...this.store.orders.values()]) {
        if (activeReqIds.has(o.requestId)) {
          // Resting on the book → placed; clear any gone marker.
          if (o.goneSince) o.goneSince = undefined;
          if (o.status !== 'placed') this.store.updateOrderStatus(o.requestId, 'placed');
          continue;
        }
        // Gone from the book. Resolve its order_id (from active earlier, or claim
        // its own fill trade now), then read settlement from THAT order_id's trades.
        if (!o.orderId) {
          const oid = claimOrderId(o);
          if (oid) this.store.resolveOrderId(o.requestId, oid);
        }
        const matched = o.orderId ? (byOrderId.get(o.orderId) ?? []) : [];
        if (matched.length > 0) {
          // Filled → settlement bucket (pending → settling → settled).
          o.goneSince = undefined;
          this.store.updateOrderStatus(o.requestId, settlementBucket(matched.map((t) => t.status)));
        } else {
          // No trade for this order yet. Almost always it filled and the trade
          // hasn't surfaced — keep waiting. Only after a LONG grace (real
          // cancel/expire, no fill) mark it cancelled.
          o.goneSince ??= now;
          if (now - o.goneSince >= CANCEL_GRACE) this.store.markCancelled(o.requestId);
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

  private warnedNoReqId = false;
  private warnNoRequestId(_orderId: string): void {
    if (this.warnedNoReqId) return;
    this.warnedNoReqId = true;
    this.store.recordError(
      'reconcile',
      'getActiveOrders returned orders without request_id — cannot join to tracked orders. Verify API shape.',
    );
  }

  // --- DepositManager (serialized across pairs) ---

  requestDeposit(symbol: string): Promise<void> {
    // Chain deposits so only one runs at a time (no double-spend / gas races).
    this.depositChain = this.depositChain.then(() => this.maybeDeposit(symbol));
    return this.depositChain;
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
