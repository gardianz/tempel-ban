import blessed from 'blessed';
import contrib from 'blessed-contrib';
import type { Store } from '../state/store.js';
import { usdValue } from '../types.js';

/** Bloomberg-terminal palette: amber phosphor on black. */
const AMBER = '#ffb000';
const AMBER_DIM = '#9a6a00';
const GREEN = '#2ecc71';
const RED = '#ff5c5c';

/**
 * Exchange-style terminal dashboard with an interactive command line.
 *
 * Read-only panels render Store snapshots on a timer: a live orderbook depth
 * ladder, a ticker, progress bars (cooldown countdown, fill rate), an open-order
 * table, balances, and rewards. A bottom command bar is ALWAYS visible (so the
 * commands are discoverable) and a raw-keystroke input line drives the bot —
 * start/stop, cooldown, withdraw — all through the Store (same as Telegram).
 */
export class Dashboard {
  private readonly screen: any;
  private readonly grid: any;
  private readonly header: any;
  private readonly bookBox: any;
  private readonly tickerBox: any;
  private readonly progressBox: any;
  private readonly rewardBox: any;
  private readonly ordersBox: any;
  private readonly messages: any;
  private readonly statsBox: any;
  private readonly balanceBox: any;
  private readonly cmdBar: any;
  private readonly cmdBox: any;
  private timer?: NodeJS.Timeout;
  /** Interactive mode: main button menu, or a value-adjust sub-mode. */
  private mode: 'menu' | 'cooldown' | 'withdraw' = 'menu';
  private menuIndex = 0;
  private cooldownDraft = 30; // seconds, adjusted with arrows
  private wAssetIdx = 0;
  private wAmount = 0;
  private readonly actions: { key: string; label: string }[] = [
    { key: 'start', label: '▶ Start' },
    { key: 'stop', label: '■ Stop' },
    { key: 'stats', label: '≡ Stats' },
    { key: 'orders', label: '☰ Orders' },
    { key: 'pairs', label: '⇄ Pairs' },
    { key: 'cooldown', label: '⏱ Cooldown' },
    { key: 'withdraw', label: '⭳ Withdraw' },
    { key: 'clear', label: '⌫ Clear' },
    { key: 'quit', label: '⏻ Quit' },
  ];
  private readonly savedConsole: Partial<Record<'log' | 'error' | 'warn', typeof console.log>> = {};

  constructor(
    private readonly store: Store,
    private readonly botName = 'TEMPLE TERMINAL',
    private readonly onWithdraw?: (asset: string, amount: number) => Promise<string>,
  ) {
    this.screen = blessed.screen({ smartCSR: true, title: this.botName, fullUnicode: true });
    this.grid = new contrib.grid({ rows: 12, cols: 12, screen: this.screen });

    this.header = this.grid.set(0, 0, 1, 12, blessed.box, { tags: true, style: { fg: 'white', bg: 'black' } });

    const panel = (label: string) => ({
      label: ` ${label} `,
      tags: true,
      style: { fg: 'white', bg: 'black', border: { fg: AMBER }, label: { fg: AMBER } },
      border: { type: 'line' },
    });

    this.bookBox = this.grid.set(1, 0, 4, 3, blessed.box, panel('ORDER BOOK'));
    this.tickerBox = this.grid.set(1, 3, 4, 4, blessed.box, panel('TICKER'));
    this.progressBox = this.grid.set(1, 7, 2, 5, blessed.box, panel('STATUS'));
    this.rewardBox = this.grid.set(3, 7, 2, 5, blessed.box, panel('VOLUME · REWARD'));
    this.ordersBox = this.grid.set(5, 0, 3, 7, blessed.box, panel('OPEN ORDERS'));
    this.messages = this.grid.set(5, 7, 3, 5, contrib.log, {
      label: ' MESSAGES ',
      tags: true,
      style: { fg: 'white', bg: 'black', border: { fg: AMBER }, label: { fg: AMBER } },
      border: { type: 'line' },
      bufferLength: 200,
    });
    this.statsBox = this.grid.set(8, 0, 1, 12, blessed.box, panel('ORDERS · DEPOSIT'));
    this.balanceBox = this.grid.set(9, 0, 1, 12, blessed.box, panel('BALANCE'));
    this.cmdBar = this.grid.set(10, 0, 1, 12, blessed.box, { tags: true, style: { fg: 'white', bg: 'black' } });
    this.cmdBox = this.grid.set(11, 0, 1, 12, blessed.box, {
      label: ' CONTROL ',
      tags: true,
      style: { fg: 'white', bg: 'black', border: { fg: AMBER }, label: { fg: AMBER } },
      border: { type: 'line' },
    });

    this.screen.on('keypress', (ch: string, key: any) => this.onKey(ch, key));
    this.store.on('event', (e: any) => this.onEvent(e));
  }

  start(intervalMs = 500): void {
    this.captureConsole();
    this.messages.log(`{${AMBER}-fg}Navigasi: ←→ pilih tombol · Enter jalankan · ↑↓ ubah nilai · Ctrl-C keluar.{/}`);
    this.renderBottom();
    this.render();
    this.timer = setInterval(() => this.render(), intervalMs);
  }

  stop(exit = false): void {
    if (this.timer) clearInterval(this.timer);
    this.restoreConsole();
    this.screen.destroy();
    if (exit) process.exit(0);
  }

  // --- interactive command line ---

  /**
   * Single key handler → dispatched per interactive mode. Ctrl-C always quits.
   *
   * blessed can deliver a keypress TWICE in the same synchronous tick (two
   * `input.on('keypress')` handlers get attached when a readline prompt ran
   * before the screen), which made one arrow press move the menu by two. Collapse
   * that: ignore a second key that arrives before the microtask drains — real key
   * events (and auto-repeat) always land in separate ticks, so they pass through.
   */
  private navLocked = false;
  private onKey(_ch: string, key: any): void {
    const name = key?.name;
    if (key?.ctrl && name === 'c') {
      this.stop(true);
      return;
    }
    if (!name) return;
    if (this.navLocked) return; // same-tick duplicate emit — drop it
    this.navLocked = true;
    queueMicrotask(() => { this.navLocked = false; });

    if (this.mode === 'menu') this.onKeyMenu(name);
    else if (this.mode === 'cooldown') this.onKeyCooldown(name);
    else if (this.mode === 'withdraw') this.onKeyWithdraw(name);
    this.renderBottom();
    this.screen.render();
  }

  private onKeyMenu(name: string): void {
    const n = this.actions.length;
    if (name === 'left') this.menuIndex = (this.menuIndex - 1 + n) % n;
    else if (name === 'right') this.menuIndex = (this.menuIndex + 1) % n;
    else if (name === 'return' || name === 'enter' || name === 'space') this.activate(this.actions[this.menuIndex]!.key);
  }

  private onKeyCooldown(name: string): void {
    if (name === 'up') this.cooldownDraft += 5;
    else if (name === 'down') this.cooldownDraft = Math.max(5, this.cooldownDraft - 5);
    else if (name === 'right') this.cooldownDraft += 1;
    else if (name === 'left') this.cooldownDraft = Math.max(5, this.cooldownDraft - 1);
    else if (name === 'return' || name === 'enter') {
      this.store.rateLimitCooldownMs = this.cooldownDraft * 1000;
      this.print(`{green-fg}✔{/} cooldown floor di-set {bold}${this.cooldownDraft}s{/}`);
      this.mode = 'menu';
    } else if (name === 'escape') this.mode = 'menu';
  }

  private onKeyWithdraw(name: string): void {
    const assets = this.withdrawAssets();
    if (assets.length === 0) { this.mode = 'menu'; return; }
    const cur = assets[this.wAssetIdx % assets.length]!;
    const bal = this.assetUnlocked(cur);
    const step = Math.max(bal * 0.1, 1e-6);
    if (name === 'left') { this.wAssetIdx = (this.wAssetIdx - 1 + assets.length) % assets.length; this.wAmount = this.assetUnlocked(assets[this.wAssetIdx]!); }
    else if (name === 'right') { this.wAssetIdx = (this.wAssetIdx + 1) % assets.length; this.wAmount = this.assetUnlocked(assets[this.wAssetIdx]!); }
    else if (name === 'up') this.wAmount = Math.min(bal, this.wAmount + step);
    else if (name === 'down') this.wAmount = Math.max(0, this.wAmount - step);
    else if (name === 'return' || name === 'enter') {
      const amt = Number(this.wAmount.toFixed(6));
      if (amt > 0 && this.onWithdraw) {
        this.print(`{${AMBER}-fg}⧗{/} withdraw ${amt} ${cur} diproses…`);
        this.onWithdraw(cur, amt)
          .then((r) => { this.print(r); this.screen.render(); })
          .catch((e) => { this.print(`{red-fg}withdraw error:{/} ${e}`); this.screen.render(); });
      } else {
        this.print(`{red-fg}?{/} jumlah 0 / withdraw tak tersedia`);
      }
      this.mode = 'menu';
    } else if (name === 'escape') this.mode = 'menu';
  }

  private withdrawAssets(): string[] {
    return Object.entries(this.store.tradingDetailed).filter(([, v]) => v.unlocked > 0).map(([k]) => k);
  }
  private assetUnlocked(a: string): number {
    return this.store.tradingDetailed[a]?.unlocked ?? 0;
  }

  /** Run a menu action (or enter a value-adjust sub-mode). */
  private activate(key: string): void {
    switch (key) {
      case 'start':
        this.store.userPaused = false;
        this.print(`{green-fg}▶ BOT JALAN{/} — order baru dipasang lagi.`);
        break;
      case 'stop':
        this.store.userPaused = true;
        this.print(`{red-fg}⛔ BOT DIJEDA{/} — order baru berhenti; order lama dibiarkan settle.`);
        break;
      case 'stats':
        for (const l of this.statsLines()) this.print(l);
        break;
      case 'orders':
        this.dumpOrders();
        break;
      case 'pairs':
        this.dumpPairs();
        break;
      case 'cooldown':
        this.cooldownDraft = Math.round(this.store.rateLimitCooldownMs / 1000);
        this.mode = 'cooldown';
        break;
      case 'withdraw': {
        const assets = this.withdrawAssets();
        if (!this.onWithdraw) { this.print(`{red-fg}?{/} withdraw tak tersedia`); break; }
        if (assets.length === 0) { this.print(`{red-fg}?{/} tak ada saldo trading (unlocked) untuk ditarik`); break; }
        this.wAssetIdx = 0;
        this.wAmount = this.assetUnlocked(assets[0]!);
        this.mode = 'withdraw';
        break;
      }
      case 'clear':
        this.messages.logLines = [];
        this.messages.setContent('');
        break;
      case 'quit':
        this.stop(true);
        break;
    }
  }

  /** Render the button bar (row 10) + context line (row 11) for the current mode. */
  private renderBottom(): void {
    const btns = this.actions
      .map((a, i) =>
        i === this.menuIndex && this.mode === 'menu'
          ? `{black-fg}{${AMBER}-bg}{bold} ${a.label} {/}`
          : `{white-fg} ${a.label} {/}`,
      )
      .join(' ');
    this.cmdBar.setContent(btns);

    let ctx: string;
    if (this.mode === 'cooldown') {
      ctx = `{${AMBER}-fg}{bold}⏱ Cooldown floor{/}  [ {bold}${this.cooldownDraft}s{/} ]   {gray-fg}↑↓ ±5 · ←→ ±1 · Enter simpan · Esc batal{/}`;
    } else if (this.mode === 'withdraw') {
      const assets = this.withdrawAssets();
      const cur = assets[this.wAssetIdx % assets.length] ?? '-';
      const bal = this.assetUnlocked(cur);
      ctx = `{${AMBER}-fg}{bold}⭳ Withdraw{/}  ← {bold}${cur}{/} →  [ {bold}${this.wAmount.toFixed(6)}{/} ]  {gray-fg}(saldo ${bal.toFixed(4)}) · ↑↓ jumlah · Enter tarik · Esc batal{/}`;
    } else {
      ctx = `{gray-fg}←→ pilih · Enter jalankan · Ctrl-C keluar{/}`;
    }
    this.cmdBox.setContent(ctx);
  }

  private print(line: string): void {
    this.messages.log(line);
  }

  private statsLines(): string[] {
    const s = this.store;
    const c = s.counters;
    const oc = s.orderCounts();
    const fs = s.fillStats();
    const dep = s.depositTotals();
    const avg = s.avgSettleMs;
    const gap = s.avgPlacedGapMs;
    const rates = [...s.pairs.values()].filter((p) => p.orderRate).map((p) => `${p.symbol} ${p.orderRate}/min`).join(', ') || '(cap dari 429)';
    const depToday = Object.entries(dep.today).map(([k, v]) => `${v.toFixed(3)} ${k}`).join(', ') || '-';
    const depMonth = Object.entries(dep.month).map(([k, v]) => `${v.toFixed(3)} ${k}`).join(', ') || '-';
    const state = s.userPaused ? '{red-fg}DIJEDA{/}' : s.tradingHalted ? '{red-fg}HALTED{/}' : '{green-fg}JALAN{/}';
    return [
      `{${AMBER}-fg}{bold}═══ STATISTIK ═══{/}  ${state}  uptime ${Math.floor(s.uptimeMs / 60_000)}m`,
      `Vol ${c.volumeQuote.toFixed(2)} | placed ${c.ordersPlaced} settled ${c.ordersSettled} | 429 ${c.count429} | CC30d ${s.ccEarned30d?.toFixed(2) ?? '?'}/tot ${s.ccEarnedTotal?.toFixed(2) ?? '?'}`,
      `Live: placed ${oc.placed} · pending ${oc.pending} · settling ${oc.settling}`,
      `Fill ${(fs.fillRate * 100).toFixed(0)}% (${fs.filled}) | cancel ${(fs.cancelRate * 100).toFixed(0)}% (${fs.cancelled}) | avg settle ${avg !== undefined ? fmtDur(avg) : '-'} | avg jeda ${gap !== undefined ? fmtDur(gap) : '-'}`,
      `Pacing: batch ${(s.orderSpacingMs / 1000).toFixed(0)}s + cooldown adaptif (floor ${(s.rateLimitCooldownMs / 1000).toFixed(0)}s) · order/60s ${s.placedLastMs(60_000)} · cap server ${rates}`,
      `Deposit hari ini ${depToday} (fee ${dep.todayCcFee.toFixed(2)} CC) | bulan ${depMonth} (fee ${dep.monthCcFee.toFixed(2)} CC)`,
    ];
  }

  private dumpPairs(): void {
    this.print(`{${AMBER}-fg}{bold}PAIRS{/}`);
    for (const p of this.store.pairs.values()) {
      const cool = this.store.cooldownMsLeft(p.symbol);
      const coolTxt = cool > 0 ? ` {${AMBER}-fg}⧗${Math.ceil(cool / 1000)}s{/}` : '';
      this.print(`  ${p.symbol} ${p.resolvedSide ?? p.side} bid ${fmt(p.bestBid)}/ask ${fmt(p.bestAsk)} open ${p.openOrders ?? 0}/${p.maxOpen ?? '-'} ${p.paused ? '{red-fg}paused{/}' : '{green-fg}aktif{/}'}${coolTxt}`);
    }
  }

  private dumpOrders(): void {
    const orders = [...this.store.orders.values()];
    if (orders.length === 0) { this.print(`{gray-fg}(tak ada order live){/}`); return; }
    this.print(`{${AMBER}-fg}{bold}ORDER LIVE (${orders.length}){/}`);
    const now = Date.now();
    for (const o of orders.slice(0, 20)) {
      const col = o.side === 'buy' ? 'green' : 'red';
      this.print(`  {${col}-fg}${o.side.toUpperCase()}{/} ${o.quantity} ${o.symbol} @ ${o.price} {gray-fg}${o.status} ${Math.round((now - o.placedAt) / 1000)}s{/}`);
    }
  }

  // --- console capture (SDK logs would corrupt the TUI) ---

  private captureConsole(): void {
    for (const m of ['log', 'error', 'warn'] as const) {
      this.savedConsole[m] = console[m].bind(console);
      console[m] = (...args: unknown[]) => this.messages.log(args.map(String).join(' '));
    }
  }

  private restoreConsole(): void {
    for (const m of ['log', 'error', 'warn'] as const) {
      const saved = this.savedConsole[m];
      if (saved) console[m] = saved;
    }
  }

  private onEvent(e: any): void {
    const id = (o: any) => o?.orderId ?? `req:${o?.requestId}`;
    switch (e.type) {
      case 'order:placed':
        this.messages.log(`{green-fg}PLACED{/} ${e.order.side} ${e.order.quantity} ${e.order.symbol} @ ${e.order.price} (${id(e.order)})`);
        break;
      case 'order:updated':
        this.messages.log(`{blue-fg}${String(e.order.status).toUpperCase()}{/} ${e.order.symbol} ${id(e.order)}`);
        break;
      case 'order:settled': {
        const took = e.order.settleMs !== undefined ? ` in ${fmtDur(e.order.settleMs)}` : '';
        const rwd = e.order.estRewardCc !== undefined ? ` ~${e.order.estRewardCc.toFixed(4)} CC` : '';
        this.messages.log(`{cyan-fg}SETTLED{/} ${e.order.side} ${e.order.symbol} @ ${e.order.price} (${id(e.order)})${took}{green-fg}${rwd}{/}`);
        break;
      }
      case 'order:cancelled':
        this.messages.log(`{yellow-fg}CANCELLED{/} ${e.order.symbol} ${id(e.order)}`);
        break;
      case 'deposit':
        this.messages.log(`{magenta-fg}DEPOSIT{/} ${e.amount} ${e.asset} ${e.ok ? 'ok' : 'FAIL'}${e.ccFee ? ` (gas ${e.ccFee} CC)` : ''}`);
        break;
      case 'info':
        this.messages.log(`{${AMBER_DIM}-fg}»{/} {${AMBER}-fg}${e.scope}{/}: ${e.message}`);
        break;
      case 'error':
        this.messages.log(`{red-fg}ERR{/} ${e.scope}: ${e.message}`);
        break;
    }
  }

  private render(): void {
    const s = this.store;
    const c = s.counters;
    const primary = [...s.pairs.values()][0];

    // HEADER — state + next-batch countdown, exchange-style.
    const cdLeft = primary ? s.cooldownMsLeft(primary.symbol) : 0;
    const state = s.userPaused
      ? '{red-fg}{bold}⛔ PAUSE{/}'
      : s.tradingHalted
        ? '{red-fg}{bold}⛔ HALT{/}'
        : cdLeft > 0
          ? `{yellow-fg}{bold}⧗ COOLDOWN ${Math.ceil(cdLeft / 1000)}s{/}`
          : '{green-fg}{bold}● LIVE{/}';
    const sep = '{gray-fg}│{/}';
    this.header.setContent(
      `{${AMBER}-fg}{bold} ${this.botName} {/} ${sep} ${s.network} ${sep} up ${Math.floor(s.uptimeMs / 60_000)}m ${sep} ${state} ${sep} ` +
        `vol {bold}${c.volumeQuote.toFixed(2)}{/} ${sep} settled ${c.ordersSettled} ${sep} 429 ${c.count429} ${sep} CC30d {${AMBER}-fg}${s.ccEarned30d?.toFixed(2) ?? '?'}{/}`,
    );

    this.renderBook(primary?.symbol);
    this.renderTicker();
    this.renderProgress(primary);
    this.renderReward();
    this.renderOrders();
    this.renderStats();
    this.renderBalance();

    this.screen.render();
  }

  private renderBook(symbol?: string): void {
    const book = symbol ? this.store.liveBooks[symbol] : undefined;
    const asks = book?.askLevels ?? [];
    const bids = book?.bidLevels ?? [];
    if (asks.length === 0 && bids.length === 0) {
      this.bookBox.setContent('{gray-fg}(menunggu orderbook…){/}');
      return;
    }
    const maxQty = Math.max(1e-12, ...asks.map((l) => l.qty), ...bids.map((l) => l.qty));
    const lines: string[] = [];
    for (const l of [...asks].reverse()) {
      lines.push(`{red-fg}${padL(fmtPrice(l.price), 8)}{/} ${bar(l.qty / maxQty, 5, RED)} {gray-fg}${fmtQty(l.qty)}{/}`);
    }
    const spread = book?.bestAsk && book?.bestBid ? book.bestAsk - book.bestBid : undefined;
    const mid = book?.bestAsk && book?.bestBid ? (book.bestAsk + book.bestBid) / 2 : undefined;
    const spPct = spread !== undefined && mid ? ((spread / mid) * 100).toFixed(3) : '-';
    lines.push(`{${AMBER}-fg}mid ${mid !== undefined ? fmtPrice(mid) : '-'}  sp ${spread !== undefined ? fmtPrice(spread) : '-'} (${spPct}%){/}`);
    for (const l of bids) {
      lines.push(`{green-fg}${padL(fmtPrice(l.price), 8)}{/} ${bar(l.qty / maxQty, 5, GREEN)} {gray-fg}${fmtQty(l.qty)}{/}`);
    }
    this.bookBox.setContent(lines.join('\n'));
  }

  private renderTicker(): void {
    const s = this.store;
    const rows: string[] = [`{${AMBER}-fg}${pad('PAIR', 11)}${pad('SIDE', 5)}${pad('BID', 9)}${pad('ASK', 9)}CAP{/}`];
    for (const p of s.pairs.values()) {
      const side = p.resolvedSide ?? p.side;
      const col = side === 'buy' ? 'green' : side === 'sell' ? 'red' : 'white';
      const cool = s.cooldownMsLeft(p.symbol);
      const dot = p.paused ? '{red-fg}⏸{/}' : cool > 0 ? `{${AMBER}-fg}⧗${Math.ceil(cool / 1000)}{/}` : '{green-fg}●{/}';
      rows.push(
        pad(p.symbol, 11) +
          `{${col}-fg}${pad(String(side), 5)}{/}` +
          pad(fmt(p.bestBid), 9) +
          pad(fmt(p.bestAsk), 9) +
          `${p.orderRate ? `${p.orderRate}/m` : '~'} ${dot}`,
      );
    }
    this.tickerBox.setContent(rows.join('\n'));
  }

  private renderProgress(primary: any): void {
    const s = this.store;
    const cdLeft = primary ? s.cooldownMsLeft(primary.symbol) : 0;
    const cdTotal = primary ? s.cooldownTotalMs[primary.symbol] ?? 0 : 0;
    const cdLine =
      cdLeft > 0 && cdTotal > 0
        ? `{${AMBER}-fg}Cooldown{/} ${bar(cdLeft / cdTotal, 12, AMBER)} {bold}${Math.ceil(cdLeft / 1000)}s{/} → batch`
        : `{${AMBER}-fg}Cooldown{/} ${bar(0, 12, AMBER)} {green-fg}siap kirim{/}`;
    const fs = s.fillStats();
    const placed60 = s.placedLastMs(60_000);
    this.progressBox.setContent(
      `${cdLine}\n` +
        `{${AMBER}-fg}Fill    {/} ${bar(fs.fillRate, 12, GREEN)} {bold}${(fs.fillRate * 100).toFixed(0)}%{/} (${fs.filled}/${fs.filled + fs.cancelled})\n` +
        `{${AMBER}-fg}Order/60s{/} ${bar(Math.min(1, placed60 / 6), 10, AMBER)} {bold}${placed60}{/}`,
    );
  }

  private renderReward(): void {
    const s = this.store;
    const c = s.counters;
    const fees = s.takerFees !== undefined ? `${s.makerFees}/${s.takerFees}` : '?';
    this.rewardBox.setContent(
      `{${AMBER}-fg}Volume{/}  ${c.volumeQuote.toFixed(2)}\n` +
        `{${AMBER}-fg}CC 30d{/}  ${s.ccEarned30d?.toFixed(2) ?? '?'}  {${AMBER}-fg}total{/} ${s.ccEarnedTotal?.toFixed(2) ?? '?'}\n` +
        `{${AMBER}-fg}Vol 30d{/} ${s.volume30d?.toFixed(0) ?? '?'}  {${AMBER}-fg}fee m/t{/} ${fees}\n` +
        `{${AMBER}-fg}Max open{/} ${s.maxLimitOrders ?? 50}  {${AMBER}-fg}avg settle{/} ${s.avgSettleMs !== undefined ? fmtDur(s.avgSettleMs) : '-'}`,
    );
  }

  private renderOrders(): void {
    const orders = [...this.store.orders.values()].sort((a, b) => b.placedAt - a.placedAt);
    // FILL = per-order fill bar (filled/original) → shows which order partially filled.
    const rows: string[] = [`{${AMBER}-fg}${pad('SIDE', 5)}${pad('QTY', 9)}${pad('PRICE', 9)}${pad('FILL', 12)}${pad('STATUS', 9)}AGE{/}`];
    const now = Date.now();
    if (orders.length === 0) {
      rows.push('{gray-fg}(tak ada order live){/}');
    } else {
      for (const o of orders.slice(0, 8)) {
        const col = o.side === 'buy' ? 'green' : 'red';
        const stCol = o.status === 'placed' ? AMBER : o.status === 'settling' || o.status === 'pending' ? '#3aa0ff' : 'gray';
        const filled = o.filledQuantity ?? 0;
        const frac = o.quantity > 0 ? Math.min(1, filled / o.quantity) : 0;
        const fillCell = `${bar(frac, 5, frac >= 1 ? GREEN : frac > 0 ? AMBER : 'gray')} ${pad(`${Math.round(frac * 100)}%`, 4)}`;
        rows.push(
          `{${col}-fg}${pad(o.side.toUpperCase(), 5)}{/}` +
            pad(fmtQty(o.quantity), 9) +
            pad(String(o.price), 9) +
            fillCell + ' ' +
            `{${stCol}-fg}${pad(o.status, 9)}{/}` +
            `${Math.round((now - o.placedAt) / 1000)}s`,
        );
      }
    }
    this.ordersBox.setContent(rows.join('\n'));
  }

  private renderStats(): void {
    const s = this.store;
    const c = s.counters;
    const oc = s.orderCounts();
    const fs = s.fillStats();
    const dep = s.depositTotals();
    const depToday = Object.entries(dep.today).map(([k, v]) => `${v.toFixed(3)} ${k}`).join(', ') || '-';
    this.statsBox.setContent(
      `placed ${c.ordersPlaced} · settled ${c.ordersSettled} · live[open ${oc.placed}/pend ${oc.pending}/settling ${oc.settling}] · ` +
        `fill {green-fg}${(fs.fillRate * 100).toFixed(0)}%{/}/cancel {red-fg}${(fs.cancelRate * 100).toFixed(0)}%{/} · ` +
        `avg settle ${s.avgSettleMs !== undefined ? fmtDur(s.avgSettleMs) : '-'} · deposit today ${depToday} (fee ${dep.todayCcFee.toFixed(2)} CC)`,
    );
  }

  private renderBalance(): void {
    const s = this.store;
    const px = s.oraclePrices;
    const td = s.tradingDetailed;
    const temple = Object.keys(td).length
      ? Object.entries(td)
          .map(([k, v]) => `${k} ${v.unlocked.toFixed(4)}/{yellow-fg}${v.locked.toFixed(4)}{/}${v.inFlight ? `/⟳${v.inFlight.toFixed(4)}` : ''}`)
          .join('  ')
      : '-';
    const wb = Object.entries(s.walletBalances).filter(([, v]) => Number(v) > 0);
    const wallet = wb.length ? wb.map(([k, v]) => `${k} ${Number(v).toFixed(4)}`).join('  ') : '{gray-fg}(menyambung…){/}';
    this.balanceBox.setContent(`{${AMBER}-fg}Trading{/} ${temple}   {${AMBER}-fg}│ Wallet{/} ${wallet}   {gray-fg}($ oracle cbtc ${px.cbtc ?? '?'} cc ${px.cc ?? '?'}){/}`);
  }
}

/** Colored progress/size bar: filled blocks + gray remainder. */
function bar(pct: number, width: number, color = GREEN): string {
  const p = Math.max(0, Math.min(1, Number.isFinite(pct) ? pct : 0));
  const fill = Math.round(p * width);
  return `{${color}-fg}${'█'.repeat(fill)}{/}{gray-fg}${'░'.repeat(Math.max(0, width - fill))}{/}`;
}

/** Left-align + pad/truncate to width n (raw text; wrap color AFTER). */
function pad(sv: string, n: number): string {
  if (n <= 0) return sv;
  return sv.length >= n ? sv.slice(0, n) : sv + ' '.repeat(n - sv.length);
}

/** Right-align pad to width n. */
function padL(sv: string, n: number): string {
  return sv.length >= n ? sv.slice(0, n) : ' '.repeat(n - sv.length) + sv;
}

function fmt(n?: number): string {
  return n === undefined ? '-' : String(n);
}

/** Price: integers as-is, small numbers to 5 significant digits. */
function fmtPrice(n: number): string {
  if (!Number.isFinite(n)) return '-';
  return n >= 100 ? String(Math.round(n)) : Number(n.toPrecision(5)).toString();
}

/** Size: trimmed to 4 decimals. */
function fmtQty(n: number): string {
  if (!Number.isFinite(n)) return '-';
  return n >= 1000 ? n.toFixed(0) : n.toFixed(4);
}

/** Human duration: 4s, 1m12s, 2h3m. */
function fmtDur(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
}
