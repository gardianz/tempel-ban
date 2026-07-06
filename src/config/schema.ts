import { z } from 'zod';

export const pairConfigSchema = z.object({
  symbol: z.string().regex(/^[A-Za-z]+\/[A-Za-z]+$/, 'symbol must be BASE/QUOTE'),
  side: z.enum(['buy', 'sell', 'auto']).default('auto'),
  enabled: z.boolean().default(true),
  postOnly: z.boolean().default(false),
  /**
   * Order type. `limit` (default) rests at best bid/ask as a maker. `market`
   * crosses the spread for an immediate taker fill — sent with a crossing price
   * (buy→best ask, sell→best bid) since the API schema requires a price > 0.
   * `market` ignores `postOnly` (a taker order cannot be post-only).
   */
  orderType: z.enum(['limit', 'market']).default('limit'),
  /**
   * Two-sided ping-pong: alternate buy↔sell phases. Drain one side's spend
   * asset, wait for all orders to settle, deposit the other side's asset from
   * the wallet, flip. `side` sets the STARTING phase. Default false = single-sided.
   */
  pingpong: z.boolean().default(false),
  /**
   * Order size in BASE token units (e.g. 0.0005 CBTC, 150 CC). When set, this
   * overrides budget-based sizing for the pair — the order quantity is fixed in
   * tokens, not derived from a quote-currency notional.
   */
  quantityPerOrder: z.number().positive().optional(),
  /** Optional per-pair override of the global budgetPerOrder (quote notional). */
  budgetPerOrder: z.number().positive().optional(),
});

export const configSchema = z.object({
  pairs: z.array(pairConfigSchema).min(1),
  /** Default order size as a QUOTE-currency notional (used when a pair has no quantityPerOrder). */
  budgetPerOrder: z.number().positive(),
  orderTtlMinutes: z.number().positive().default(10),
  /**
   * When the sized order quantity is below the exchange minimum: `bump` (default)
   * auto-uses the minimum so a raised min-order-size never stalls the bot; `skip`
   * skips the order (strict cost control).
   */
  onBelowMin: z.enum(['bump', 'skip']).default('bump'),
  /**
   * Max concurrent resting orders per pair. `"auto"` derives it from the symbol's
   * order rate × TTL (how many can accumulate before the first re-quote), capped
   * by the account's max_limit_orders. A number forces a fixed cap.
   */
  maxOpenOrders: z.union([z.number().int().positive(), z.literal('auto')]).default('auto'),
  remainingThresholdN: z.number().int().nonnegative().default(0),
  /** Per-asset amount to keep in the Loop wallet (never deposit). */
  walletReserve: z.record(z.string(), z.number().nonnegative()).default({}),
  /** Gas guard: stop ALL deposits when wallet CC falls below this (each deposit burns CC). Floored to the 10 CC fee reserve. */
  minWalletCc: z.number().nonnegative().default(10),
  /**
   * Slippage buffer for `market` orders (fraction, e.g. 0.005 = 0.5%). The API
   * requires a price even for market orders and treats it as a worst-case fill
   * cap (IOC-style) — sending exactly best ask/bid risks an instant no-fill
   * cancel when the level moves a tick. The buffer (buy: ×(1+s), sell: ×(1−s))
   * guarantees the order crosses; the server still fills at the real market price.
   */
  marketSlippagePct: z.number().nonnegative().default(0.005),
  /** Spacing between order submits within a batch (seconds). Default 2s. */
  orderSpacingSec: z.number().nonnegative().default(2),
  /** Cooldown after a rate-limit (429/249) before submitting again (seconds). Default 30s. */
  rateLimitCooldownSec: z.number().positive().default(30),
  ratePerMinute: z.number().positive().default(30),
  maxRatePerMinute: z.number().positive().default(60),
  /** Min gap between API requests (ms) — spaces bursts under a per-second server cap. */
  minRequestIntervalMs: z.number().nonnegative().default(150),
  pollIntervalSec: z.number().positive().default(15),
  summaryIntervalMin: z.number().positive().default(30),
}).refine((c) => c.maxRatePerMinute >= c.ratePerMinute, {
  message: 'maxRatePerMinute must be >= ratePerMinute',
  path: ['maxRatePerMinute'],
});

export type PairConfig = z.infer<typeof pairConfigSchema>;
export type Config = z.infer<typeof configSchema>;

export const envSchema = z.object({
  TEMPLE_API_KEY: z.string().min(1, 'TEMPLE_API_KEY required'),
  LOOP_PRIVATE_KEY: z.string().min(1, 'LOOP_PRIVATE_KEY required'),
  LOOP_PARTY_ID: z.string().min(1, 'LOOP_PARTY_ID required'),
  NETWORK: z.enum(['mainnet', 'testnet']),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),
  /** Proxy for all outbound HTTP (Cantonloop auth blocks datacenter IPs). */
  PROXY_URL: z.string().optional(),
  /** Newline/comma-separated proxy pool for rotation. */
  PROXY_LIST: z.string().optional(),
  /** Path to a proxy pool file (one proxy URL per line). Default: ./proxy.txt. */
  PROXY_FILE: z.string().optional(),
  /** 'wallet' (default): proxy only cantonloop/loop. 'all': also Temple REST. */
  PROXY_SCOPE: z.enum(['wallet', 'all']).default('wallet'),
});

export type Env = z.infer<typeof envSchema>;
