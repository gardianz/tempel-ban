// Minimal ambient types for the untyped @temple-digital-group/temple-canton-js SDK.
// Only the surface the bot uses is declared; everything else stays `any`.
declare module '@temple-digital-group/temple-canton-js' {
  export interface InitConfig {
    API_KEY: string;
    NETWORK: 'mainnet' | 'testnet' | 'localhost';
    WALLET_ADAPTER?: unknown;
  }
  export function initialize(config: InitConfig): Promise<void> | void;
  export function setWalletAdapter(adapter: unknown): void;

  export function getSupportedTradingPairs(): Promise<string[]>;
  export function getInstrumentCatalog(): Promise<unknown>;

  export function isUserOnboarded(party: string): Promise<unknown>;
  export function onboardUser(party: { partyId: string }): Promise<{ delegation?: unknown; warning?: string }>;
  export function withdrawDelegation(delegationId?: string, user?: string): Promise<unknown>;

  export function deposit(amount: number, symbol: string): Promise<unknown>;
  export function withdrawFunds(opts: { asset_id: string; amount: string }): Promise<unknown>;

  export interface BalanceEntry {
    asset: string;
    unlocked?: number;
    locked?: number;
    in_flight?: number;
    available_balance?: number;
    total_balance?: number;
  }
  export function getTradingBalance(): Promise<any>;
  export function getUserBalances(party?: string, provider?: unknown): Promise<any>;

  // NOTE: REST wrappers return the RAW server JSON and DO NOT throw — on failure
  // they resolve to `{ error: true, status, code, message }`. Callers must check
  // for that shape. Returns are typed `any` because shapes are server-defined.
  export function getSymbolConfig(symbol: string): Promise<any>;
  export function getOrderBook(symbol: string, options?: { levels?: number; precision?: number }): Promise<any>;

  export interface CreateOrderOpts {
    symbol: string;
    side: 'buy' | 'sell';
    quantity: number;
    price: number;
    order_type: 'limit' | 'market';
    order_subtype?: 'post_only' | string;
    expires_at?: string | number;
  }
  // Response: { success, request_id (int), message }. No order_id is returned;
  // resolve order_id later from getActiveOrders by matching request_id.
  export function createOrderRequest(opts: CreateOrderOpts): Promise<any>;
  export function cancelOrder(orderId: string): Promise<any>;
  export function cancelAllOrders(options?: { symbol?: string }): Promise<any>;

  export interface ActiveOrder {
    order_id?: string;
    request_id?: number | string;
    symbol?: string;
    side?: 'buy' | 'sell';
    price?: number | string;
    quantity?: number | string;
    status?: string;
    [k: string]: unknown;
  }
  // Response: { orders: ActiveOrder[], count, total_count, limit, has_more }.
  export function getActiveOrders(options?: { symbol?: string; limit?: number }): Promise<any>;

  export type Unsub = () => void;
  export function subscribeOrderbook(symbol: string, cb: (data: unknown) => void): Unsub;
  export function subscribeUserOrders(cb: (data: unknown) => void): Unsub;
  export function subscribeUserBalances(cb: (data: unknown) => void): Unsub;
  export function disconnectWebSocket(): void;

  // ApiError shape thrown by REST wrappers.
  export class ApiError extends Error {
    status?: number;
    code?: string | number;
    retryAfter?: number;
  }
}

declare module '@fivenorth/loop-sdk' {
  const anyExport: any;
  export = anyExport;
}
