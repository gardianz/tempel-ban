import blessed from 'blessed';
import contrib from 'blessed-contrib';
import type { Store } from '../state/store.js';
import { usdValue } from '../types.js';

/**
 * Read-only blessed-contrib grid. Renders Store snapshots on a timer; never
 * mutates state. Volume sparkline is sampled each render into a rolling window.
 */
export class Dashboard {
  private readonly screen: any;
  private readonly grid: any;
  private readonly header: any;
  private readonly pairsTable: any;
  private readonly logBox: any;
  private readonly gauge: any;
  private readonly statsBox: any;
  private readonly balanceBox: any;
  private readonly footer: any;
  private timer?: NodeJS.Timeout;
  private readonly savedConsole: Partial<Record<'log' | 'error' | 'warn', typeof console.log>> = {};

  constructor(private readonly store: Store, private readonly botName = 'temple-opusxfable') {
    this.screen = blessed.screen({ smartCSR: true, title: this.botName });
    this.screen.key(['q', 'C-c'], () => this.stop(true));

    this.grid = new contrib.grid({ rows: 12, cols: 12, screen: this.screen });
    this.header = this.grid.set(0, 0, 2, 12, blessed.box, { tags: true, label: ' Temple Volume Bot ' });
    this.pairsTable = this.grid.set(2, 0, 5, 7, contrib.table, {
      label: ' Pairs ',
      columnWidth: [12, 6, 4, 9, 9, 8, 6, 7],
      columnSpacing: 1,
      interactive: false,
    });
    this.gauge = this.grid.set(2, 7, 2, 5, contrib.gauge, { label: ' Rate ' });
    this.statsBox = this.grid.set(4, 7, 3, 5, blessed.box, { tags: true, label: ' Orders & Rewards ' });
    this.logBox = this.grid.set(7, 0, 3, 12, contrib.log, { label: ' Order Log ', tags: true });
    this.balanceBox = this.grid.set(10, 0, 1, 12, blessed.box, { tags: true, label: ' Temple (unlocked/locked) ' });
    this.footer = this.grid.set(11, 0, 1, 12, blessed.box, { tags: true, label: ' Loop Wallet ' });

    // Pipe store events into the live log.
    this.store.on('event', (e: any) => this.onEvent(e));
  }

  start(intervalMs = 1000): void {
    this.captureConsole();
    this.render();
    this.timer = setInterval(() => this.render(), intervalMs);
  }

  stop(exit = false): void {
    if (this.timer) clearInterval(this.timer);
    this.restoreConsole();
    this.screen.destroy();
    if (exit) process.exit(0);
  }

  /**
   * The Temple SDK logs to console.error/log on every API error, which would
   * corrupt the blessed TUI. Redirect console output into the order log box
   * while the dashboard owns the screen.
   */
  private captureConsole(): void {
    for (const m of ['log', 'error', 'warn'] as const) {
      this.savedConsole[m] = console[m].bind(console);
      console[m] = (...args: unknown[]) => this.logBox.log(args.map(String).join(' '));
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
        this.logBox.log(`{green-fg}PLACED{/} ${e.order.side} ${e.order.quantity} ${e.order.symbol} @ ${e.order.price} (${id(e.order)})`);
        break;
      case 'order:updated': // pending → settling (filled, settling on-chain)
        this.logBox.log(`{blue-fg}${String(e.order.status).toUpperCase()}{/} ${e.order.symbol} ${id(e.order)}`);
        break;
      case 'order:settled': {
        const took = e.order.settleMs !== undefined ? ` in ${fmtDur(e.order.settleMs)}` : '';
        const rwd = e.order.estRewardCc !== undefined ? ` ~${e.order.estRewardCc.toFixed(4)} CC` : '';
        this.logBox.log(`{cyan-fg}SETTLED{/} ${e.order.side} ${e.order.symbol} @ ${e.order.price} (${id(e.order)})${took}{green-fg}${rwd}{/}`);
        break;
      }
      case 'order:cancelled':
        this.logBox.log(`{yellow-fg}CANCELLED{/} ${e.order.symbol} ${id(e.order)}`);
        break;
      case 'deposit':
        this.logBox.log(`{magenta-fg}DEPOSIT{/} ${e.amount} ${e.asset} ${e.ok ? 'ok' : 'FAIL'}`);
        break;
      case 'info':
        this.logBox.log(`{gray-fg}»{/} ${e.scope}: ${e.message}`);
        break;
      case 'error':
        this.logBox.log(`{red-fg}ERR{/} ${e.scope}: ${e.message}`);
        break;
    }
  }

  private render(): void {
    const c = this.store.counters;
    const upMin = Math.floor(this.store.uptimeMs / 60_000);
    const srvLimit =
      this.store.serverRateLimit !== undefined
        ? ` srv-limit=${this.store.serverRateLimit}(rem ${this.store.serverRateRemaining ?? '?'})`
        : '';
    const reward = this.store.ccEarned30d !== undefined ? ` CC30d=${this.store.ccEarned30d.toFixed(2)}` : '';
    const halted = this.store.tradingHalted ? ' {red-fg}[HALTED]{/}' : '';
    this.header.setContent(
      `{bold}${this.botName}{/}  net=${this.store.network}  up=${upMin}m${halted}   ` +
        `vol=${c.volumeQuote.toFixed(2)} placed=${c.ordersPlaced} settled=${c.ordersSettled} 429=${c.count429}${srvLimit}${reward}`,
    );

    const rows: string[][] = [];
    for (const p of this.store.pairs.values()) {
      const dot = p.paused ? '⏸' : '●';
      const lim = p.orderRate ? `${p.orderRate}/m` : '∞';
      const open = `${p.openOrders ?? 0}/${p.maxOpen ?? '-'}`;
      rows.push([
        p.symbol,
        p.resolvedSide ?? p.side, // phase (buy/sell) in ping-pong
        dot,
        fmt(p.bestBid),
        fmt(p.bestAsk),
        String(p.lastQty ?? '-'),
        open,
        lim,
      ]);
    }
    this.pairsTable.setData({
      headers: ['Pair', 'Side', 'St', 'Bid', 'Ask', 'Qty', 'Open', 'Lim'],
      data: rows,
    });

    // Rate gauge vs the server-advertised limit (fallback 60).
    const ceil = this.store.serverRateLimit || 60;
    this.gauge.setPercent(Math.min(100, Math.round((this.store.rate / ceil) * 100)));

    // Orders & rewards panel.
    const oc = this.store.orderCounts();
    const r30 = this.store.ccEarned30d?.toFixed(2) ?? '?';
    const rTot = this.store.ccEarnedTotal?.toFixed(2) ?? '?';
    const fees = this.store.takerFees !== undefined ? `${this.store.makerFees}/${this.store.takerFees}` : '?';
    const avg = this.store.avgSettleMs;
    const fs = this.store.fillStats();
    const dep = this.store.depositTotals();
    const depToday = Object.entries(dep.today).map(([k, v]) => `${v.toFixed(3)} ${k}`).join(', ') || '-';
    const depMonth = Object.entries(dep.month).map(([k, v]) => `${v.toFixed(3)} ${k}`).join(', ') || '-';
    this.statsBox.setContent(
      `{bold}Orders{/}  placed ${oc.placed} | pending ${oc.pending} | settling ${oc.settling} | settled ${c.ordersSettled}\n` +
        `  fill ${(fs.fillRate * 100).toFixed(0)}% (${fs.filled}) | cancel ${(fs.cancelRate * 100).toFixed(0)}% (${fs.cancelled})\n` +
        `  avg settle ${avg !== undefined ? fmtDur(avg) : '-'}\n` +
        `{bold}Deposit{/}  today ${depToday} (fee ${dep.todayCcFee.toFixed(2)} CC)\n` +
        `  month ${depMonth} (fee ${dep.monthCcFee.toFixed(2)} CC)\n` +
        `{bold}Rewards (CC){/}  30d ${r30} / total ${rTot}  fees m/t ${fees}`,
    );

    const px = this.store.oraclePrices;
    // Temple trading balances — unlocked / locked / in-flight + USD per asset.
    const td = this.store.tradingDetailed;
    const tline = Object.keys(td).length
      ? Object.entries(td)
          .map(([k, v]) => `${k} ${v.unlocked.toFixed(4)}/{yellow-fg}${v.locked.toFixed(4)}{/}${v.inFlight ? `/⟳${v.inFlight.toFixed(4)}` : ''} ($${usdValue(k, v.unlocked, px).toFixed(2)})`)
          .join('   ')
      : '-';
    this.balanceBox.setContent(tline);

    // Loop wallet balances + USD (the largest-USD asset is what gets deposited).
    const wb = Object.entries(this.store.walletBalances);
    const wline = wb.length
      ? wb.map(([k, v]) => `${k}:${typeof v === 'number' ? v.toFixed(4) : v} ($${usdValue(k, Number(v) || 0, px).toFixed(2)})`).join('   ')
      : '(connecting…)';
    this.footer.setContent(wline);

    this.screen.render();
  }
}

function fmt(n?: number): string {
  return n === undefined ? '-' : String(n);
}

/** Human duration: 4.2s, 1m12s, 2h3m. */
function fmtDur(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
}
