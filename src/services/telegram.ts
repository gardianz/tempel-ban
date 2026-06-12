import { Bot } from 'grammy';
import type { Store, StoreEvent } from '../state/store.js';
import type { Env } from '../config/index.js';
import { splitPair, usdValue, type TrackedOrder } from '../types.js';

/**
 * Telegram notifier. Subscribes to store events and pushes order-lifecycle and
 * auto-deposit messages, plus a periodic summary. Errors/429s are deliberately
 * NOT sent here (dashboard only) to avoid spam.
 *
 * No-ops gracefully when TELEGRAM_* env vars are absent.
 */
export class TelegramNotifier {
  private readonly bot?: Bot;
  private readonly chatId?: string;
  private summaryTimer?: NodeJS.Timeout;

  constructor(env: Env) {
    if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
      this.bot = new Bot(env.TELEGRAM_BOT_TOKEN);
      this.chatId = env.TELEGRAM_CHAT_ID;
    }
  }

  get enabled(): boolean {
    return Boolean(this.bot && this.chatId);
  }

  /** Wire store events + start the periodic summary timer. */
  attach(store: Store, summaryIntervalMin: number): void {
    if (!this.enabled) return;
    this.send('🤖 Temple bot started.');
    store.on('event', (e: StoreEvent) => this.onEvent(e));
    // First snapshot after ~45s (balances/rewards populated), then periodic.
    setTimeout(() => this.sendSummary(store), 45_000).unref?.();
    this.summaryTimer = setInterval(() => this.sendSummary(store), summaryIntervalMin * 60_000);
    if (this.summaryTimer.unref) this.summaryTimer.unref();
  }

  private onEvent(e: StoreEvent): void {
    switch (e.type) {
      case 'deposit':
        this.send(`${e.ok ? '💰' : '⚠️'} Deposit ${e.amount} ${e.asset} — ${e.ok ? 'ok' : 'FAILED'}`);
        return;
      case 'order:placed':
        this.send(this.orderMsg(e.order, 'placed'));
        return;
      case 'order:updated':
        // pending / settling transitions (terminal states have their own events).
        this.send(this.orderMsg(e.order, e.order.status));
        return;
      case 'order:settled':
        this.send(this.orderMsg(e.order, 'settled'));
        return;
      case 'order:cancelled':
        this.send(this.orderMsg(e.order, 'cancelled'));
        return;
      default:
        return;
    }
  }

  /** Format a per-order lifecycle message (matches the dashboard's order card). */
  private orderMsg(o: TrackedOrder, status: string): string {
    const sideIcon = o.side === 'buy' ? '🟢' : '🔴';
    const stateLabel: Record<string, string> = {
      placed: `${sideIcon} <b>${o.side.toUpperCase()} ORDER PLACED</b>`,
      pending: `⏳ <b>${o.side.toUpperCase()} PENDING</b>`,
      settling: `🔄 <b>${o.side.toUpperCase()} SETTLING</b>`,
      settled: `✅ <b>${o.side.toUpperCase()} SETTLED</b>`,
      cancelled: `❌ <b>${o.side.toUpperCase()} CANCELLED</b>`,
    };
    const { base } = splitPair(o.symbol);
    const head = stateLabel[status] ?? `${sideIcon} <b>${o.side.toUpperCase()} ${status.toUpperCase()}</b>`;
    return [
      head,
      `${o.symbol}`,
      `💰 Price: ${o.price}`,
      `📦 Qty: ${o.quantity} ${base}`,
    ].join('\n');
  }

  /** Rich periodic snapshot: wallet, Temple balances, order status, rewards. */
  private sendSummary(store: Store): void {
    const c = store.counters;
    const px = store.oraclePrices;
    const upMin = Math.floor(store.uptimeMs / 60_000);
    const oc = store.orderCounts();

    const temple = Object.entries(store.tradingDetailed)
      .map(([k, v]) => `  ${k}: ${v.unlocked.toFixed(4)} unl / ${v.locked.toFixed(4)} lck ($${usdValue(k, v.unlocked + v.locked, px).toFixed(2)})`)
      .join('\n');
    const wallet = Object.entries(store.walletBalances)
      .filter(([, v]) => Number(v) > 0)
      .map(([k, v]) => `  ${k}: ${Number(v).toFixed(4)} ($${usdValue(k, Number(v), px).toFixed(2)})`)
      .join('\n');

    const lines = [
      `📊 <b>Temple Bot</b> — ${upMin}m uptime${store.tradingHalted ? '  ⛔ HALTED' : ''}`,
      ``,
      `<b>Orders</b>  placed ${oc.placed} | pending ${oc.pending} | settling ${oc.settling} | settled ${c.ordersSettled}`,
      `Volume ${c.volumeQuote.toFixed(2)} | 429 ${c.count429} | rate ${store.rate}/min`,
      ``,
      `<b>Temple (trading)</b>\n${temple || '  -'}`,
      ``,
      `<b>Loop wallet</b>\n${wallet || '  (not loaded)'}`,
      ``,
      `<b>Rewards (CC)</b>  30d ${store.ccEarned30d?.toFixed(2) ?? '?'} | total ${store.ccEarnedTotal?.toFixed(2) ?? '?'}`,
    ];
    this.send(lines.join('\n'));
  }

  private send(text: string): void {
    if (!this.bot || !this.chatId) return;
    // fire-and-forget; never let Telegram failures break trading.
    this.bot.api.sendMessage(this.chatId, text, { parse_mode: 'HTML' }).catch(() => {});
  }

  stop(): void {
    if (this.summaryTimer) clearInterval(this.summaryTimer);
  }
}
