import { Bot } from 'grammy';
import type { Store, StoreEvent } from '../state/store.js';
import type { Env } from '../config/index.js';
import { usdValue } from '../types.js';

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
    // Per-order events are too frequent (≈6/min) for Telegram — those live on the
    // dashboard. Only deposits (rare, important) are pushed immediately; balances/
    // order status/rewards go in the periodic summary.
    if (e.type === 'deposit') {
      this.send(`${e.ok ? '💰' : '⚠️'} Deposit ${e.amount} ${e.asset} — ${e.ok ? 'ok' : 'FAILED'}`);
    }
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
