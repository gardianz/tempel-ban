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
  private store?: Store;

  constructor(env: Env) {
    if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
      this.bot = new Bot(env.TELEGRAM_BOT_TOKEN);
      this.chatId = env.TELEGRAM_CHAT_ID;
    }
  }

  get enabled(): boolean {
    return Boolean(this.bot && this.chatId);
  }

  /** Wire store events, register control commands, start the summary timer. */
  attach(store: Store, summaryIntervalMin: number): void {
    if (!this.enabled) return;
    this.store = store;
    this.registerCommands();
    this.send('🤖 Temple bot started. Kirim /help untuk daftar perintah.');
    store.on('event', (e: StoreEvent) => this.onEvent(e));
    // First snapshot after ~45s (balances/rewards populated), then periodic.
    setTimeout(() => this.sendSummary(store), 45_000).unref?.();
    this.summaryTimer = setInterval(() => this.sendSummary(store), summaryIntervalMin * 60_000);
    if (this.summaryTimer.unref) this.summaryTimer.unref();
  }

  /**
   * Register Telegram command handlers and start long-polling. SECURITY: only
   * the configured TELEGRAM_CHAT_ID may issue commands — this controls a
   * real-money mainnet bot, so every other chat is silently ignored.
   */
  private registerCommands(): void {
    const bot = this.bot;
    if (!bot) return;

    // Auth gate: drop any update not from the owner chat.
    bot.use(async (ctx, next) => {
      if (String(ctx.chat?.id) === this.chatId) await next();
    });

    bot.command('start', async (ctx) => {
      if (this.store) this.store.userPaused = false;
      await ctx.reply('▶️ Bot dijalankan. Order baru akan dipasang lagi.');
    });
    bot.command('stop', async (ctx) => {
      if (this.store) this.store.userPaused = true;
      await ctx.reply('⛔ Bot dijeda. Order baru berhenti; order lama dibiarkan settle.');
    });
    bot.command('stats', async (ctx) => {
      await ctx.reply(this.store ? this.buildSummary(this.store) : 'store belum siap', { parse_mode: 'HTML' });
    });
    bot.command('status', async (ctx) => {
      const s = this.store;
      const state = !s ? '?' : s.userPaused ? '⛔ DIJEDA (user)' : s.tradingHalted ? '⛔ HALTED (exchange)' : '▶️ JALAN';
      await ctx.reply(`Status: ${state}`);
    });
    bot.command('help', async (ctx) => {
      await ctx.reply(
        [
          '<b>Perintah Temple Bot</b>',
          '/start — jalankan bot (pasang order lagi)',
          '/stop — jeda bot (stop order baru, order lama settle)',
          '/status — status singkat (jalan/jeda/halted)',
          '/stats — statistik lengkap (order, reward, limit/menit, deposit, saldo)',
          '/help — bantuan ini',
        ].join('\n'),
        { parse_mode: 'HTML' },
      );
    });

    bot.catch(() => {}); // never let a Telegram error crash the process
    // Long-poll in the background; do not await (runs for the process lifetime).
    bot.start({ drop_pending_updates: true }).catch(() => {});
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
    const lines = [
      head,
      `${o.symbol}`,
      `💰 Price: ${o.price}`,
      `📦 Qty: ${o.quantity} ${base}`,
    ];
    if (status === 'settled') {
      if (o.settleMs !== undefined) lines.push(`⏱ Settle: ${fmtDur(o.settleMs)} (pending→settled)`);
      if (o.estRewardCc !== undefined) lines.push(`🎁 Est. reward: ~${o.estRewardCc.toFixed(4)} CC`);
    }
    return lines.join('\n');
  }

  /** Send the rich snapshot (used by the periodic timer). */
  private sendSummary(store: Store): void {
    this.send(this.buildSummary(store));
  }

  /** Build the rich snapshot text: status, orders, pacing, deposits, balances, rewards. */
  private buildSummary(store: Store): string {
    const c = store.counters;
    const px = store.oraclePrices;
    const upMin = Math.floor(store.uptimeMs / 60_000);
    const oc = store.orderCounts();
    const avg = store.avgSettleMs;
    const avgGap = store.avgPlacedGapMs;
    const fs = store.fillStats();
    const dep = store.depositTotals();

    const temple = Object.entries(store.tradingDetailed)
      .map(([k, v]) => `  ${k}: ${v.unlocked.toFixed(4)} unl / ${v.locked.toFixed(4)} lck ($${usdValue(k, v.unlocked + v.locked, px).toFixed(2)})`)
      .join('\n');
    const wallet = Object.entries(store.walletBalances)
      .filter(([, v]) => Number(v) > 0)
      .map(([k, v]) => `  ${k}: ${Number(v).toFixed(4)} ($${usdValue(k, Number(v), px).toFixed(2)})`)
      .join('\n');
    const depToday = Object.entries(dep.today).map(([k, v]) => `${v.toFixed(3)} ${k}`).join(', ') || '-';
    const depMonth = Object.entries(dep.month).map(([k, v]) => `${v.toFixed(3)} ${k}`).join(', ') || '-';
    // Current per-symbol order rate cap (re-checked ~every 5 min, applied on change).
    const rates = [...store.pairs.values()]
      .filter((p) => p.orderRate)
      .map((p) => `${p.symbol} ${p.orderRate}/min`)
      .join(', ') || '-';
    const state = store.userPaused ? '  ⛔ DIJEDA' : store.tradingHalted ? '  ⛔ HALTED' : '';

    const lines = [
      `📊 <b>Temple Bot</b> — ${upMin}m uptime${state}`,
      ``,
      `<b>Orders</b>  placed ${oc.placed} | pending ${oc.pending} | settling ${oc.settling} | settled ${c.ordersSettled}`,
      `Fill ${(fs.fillRate * 100).toFixed(0)}% (${fs.filled}) | cancel ${(fs.cancelRate * 100).toFixed(0)}% (${fs.cancelled})`,
      `Avg settle ${avg !== undefined ? fmtDur(avg) : '-'} (pending→settled)`,
      `Volume ${c.volumeQuote.toFixed(2)} | 429 ${c.count429} | order rate ${rates}`,
      `Avg jeda placed ${avgGap !== undefined ? fmtDur(avgGap) : '-'}`,
      ``,
      `<b>Deposit hari ini</b>  ${depToday}  (fee ${dep.todayCcFee.toFixed(2)} CC)`,
      `<b>Deposit bulan ini</b>  ${depMonth}  (fee ${dep.monthCcFee.toFixed(2)} CC)`,
      ``,
      `<b>Temple (trading)</b>\n${temple || '  -'}`,
      ``,
      `<b>Loop wallet</b>\n${wallet || '  (not loaded)'}`,
      ``,
      `<b>Rewards (CC)</b>  30d ${store.ccEarned30d?.toFixed(2) ?? '?'} | total ${store.ccEarnedTotal?.toFixed(2) ?? '?'}`,
    ];
    return lines.join('\n');
  }

  private send(text: string): void {
    if (!this.bot || !this.chatId) return;
    // fire-and-forget; never let Telegram failures break trading.
    this.bot.api.sendMessage(this.chatId, text, { parse_mode: 'HTML' }).catch(() => {});
  }

  stop(): void {
    if (this.summaryTimer) clearInterval(this.summaryTimer);
    void this.bot?.stop();
  }
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
