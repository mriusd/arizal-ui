/** Generated from openapi.yaml (keep in sync; `npm run gen-types`). */
export type Side = "Yes" | "No";
export type OrderType = "Limit" | "Ioc" | "PostOnly";
export type Tif = "GTC" | "GTD" | "FOK" | "FAK";

export interface SignedOrder {
  trader: string;
  market_id: string;
  side: Side;
  price: number;
  size: string | number;
  order_type: OrderType;
  tif: Tif;
  nonce: number;
  salt: number;
  expires_at: number;
  /** Absolute USDC raw; ≥ 80% of config `gas_fee`, or `0` when `order_type` is PostOnly. */
  gas_fee: number;
  chain_id: number;
  verifying_contract: `0x${string}`;
}

/** Off-chain EIP-712 ApproveAgent proof (no chain tx). */
export interface AgentAuth {
  arizal_chain: string;
  agent_address: string;
  nonce: number;
  expires_at: number;
  signature: string;
}

export interface PlaceOrder {
  order: SignedOrder;
  signature: string;
  /** Required when `signature` is from a session agent, not the main wallet. */
  agent_auth?: AgentAuth;
  close?: boolean;
}

export interface CancelOrder {
  trader: string;
  market_id: string;
  nonce: number;
  signature: string;
  agent_auth?: AgentAuth;
}

export interface CancelAll {
  trader: string;
  market_id?: string;
  nonce: number;
  signature: string;
  agent_auth?: AgentAuth;
}

export interface CancelAllResult {
  ok: boolean;
  count: number;
  /** Present only for failures; successful cancels are counted, not listed. */
  errors?: Array<{
    order_id?: number;
    market_id?: string;
    error?: string;
  }>;
}

export interface BatchCancel {
  order_id: number;
  trader: string;
  market_id: string;
  nonce: number;
  signature: string;
}

export interface BatchOp {
  cancel?: BatchCancel;
  order?: SignedOrder;
  signature?: string;
}

export interface BatchRequest {
  ops?: BatchOp[];
  cancels?: BatchCancel[];
  orders?: PlaceOrder[];
}

export interface BatchCancelResult {
  ok: boolean;
  order_id?: number;
  remaining_cancelled?: string;
  market_id?: string;
  error?: string;
}

export interface BatchOrderResult {
  ok: boolean;
  order_id?: number;
  fills?: number[];
  status?: string;
  remaining?: string;
  market_id?: string;
  error?: string;
}

export interface BatchResult {
  results: Array<BatchCancelResult & BatchOrderResult>;
  cancels?: BatchCancelResult[];
  orders?: BatchOrderResult[];
}

export interface Fill {
  fill_id: number;
  market_id: string;
  taker_order_id: number;
  maker_order_id: number;
  taker_side: Side;
  maker_side: Side;
  yes_price: number;
  size: string | number;
  taker_fee?: number;
  maker_fee?: number;
  ts_engine: number;
  log_seq: number;
  close_side?: Side | null;
  tx_hash?: string;
  confirmed?: boolean;
}

export type MarketKind = "hit" | "above" | "between";
export type MarketTimeframe = "daily" | "weekly" | "monthly" | "quarterly";

export interface Market {
  id: string;
  symbol: string;
  start_ts: number;
  barrier: string;
  direction: "up" | "down";
  tick_size: number;
  min_size: string | number;
  status: "Upcoming" | "Open" | "Locked" | "Resolved";
  winning_side: Side | null;
  resolution_price: string | number | null;
  resolved_at?: number | null;
  /** Latest Yes fill ¢ from the node trades panel; optional. */
  last_yes_price?: number | null;
  /** Best Yes bid ¢ from the live book (memory); optional on list/WS. */
  /** Best Yes bid in decicents; optional on list/WS. */
  best_yes_bid?: number | null;
  /** Best Yes ask in decicents (`1000 −` best No bid); optional on list/WS. */
  best_yes_ask?: number | null;
  /** hit | above | between. Default hit for legacy rows. */
  kind?: MarketKind;
  /** Unix seconds when the market expires (UTC midnight). */
  expires_at?: number;
  /** Upper barrier for between markets. */
  barrier_high?: string | null;
  /** Contract length. Default daily for legacy rows. */
  timeframe?: MarketTimeframe;
}

export interface Book {
  market_id: string;
  status?: string;
  bids_yes: [number, number | string][];
  bids_no: [number, number | string][];
  seq: number;
}

export interface Account {
  trader: string;
  collateral: number;
  reserved: number;
  available: number;
  /** 30d weighted volume in micro-USD (same scale as balance). */
  volume_30d?: number;
  /** Taker fee coefficient for this wallet's volume tier (e.g. 0.07). */
  taker_coeff?: number;
  nickname?: string | null;
  email?: string | null;
  email_verified?: boolean;
  /** Referring wallet; set once on first connect with `?r=`. */
  referrer?: string | null;
  /** Lifetime weighted volume from referred takers (micro-USD). */
  referred_taker_volume?: number;
  /** Lifetime weighted volume from referred makers (micro-USD). */
  referred_maker_volume?: number;
  /** Lifetime taker fees paid by referred wallets (USDC raw / micro-USD). */
  referred_taker_fees?: number;
  yes_shares: string | number;
  no_shares: string | number;
  yes_usdc_staked?: number;
  no_usdc_staked?: number;
  eth_wei?: string;
  usdc_unit: number;
  open_orders: {
    id: number;
    market_id: string;
    side: Side;
    price: number;
    size?: string | number;
    remaining: string | number;
    status: string;
    tif?: Tif;
    expires_at?: number;
  }[];
}

export interface ReferralRow {
  trader: string;
  taker_volume: number;
  maker_volume: number;
  taker_fees: number;
}

export interface ReferralsReport {
  trader: string;
  referrals: ReferralRow[];
  referred_taker_volume: number;
  referred_maker_volume: number;
  referred_taker_fees: number;
}

export interface LedgerOrder {
  id: number;
  market_id: string;
  side: Side;
  price: number;
  size: string;
  remaining: string;
  tif: string;
  /** Unix seconds; 0 / omitted = no order expiry (GTC). */
  expires_at?: number;
  status: string;
  ts: number;
}

export interface LedgerTrade {
  id: number;
  market_id: string;
  side: Side;
  price: number;
  yes_price: number;
  size: string;
  is_taker: boolean;
  ts: number;
  closing?: boolean;
  pnl?: number;
  fee?: number;
  op?: string;
  status?: string;
  tx_hash?: string;
  log_index?: number;
  block?: number;
}

export interface LedgerFund {
  kind: "deposit" | "withdraw" | string;
  amount: number;
  ts: number;
  tx_hash: string;
  log_index?: number;
  block?: number;
  status?: string;
}

export interface LedgerPos {
  market_id: string;
  side: Side;
  shares: string;
  usdc_staked: number;
  updated_at: number;
  redeemed?: boolean;
}

export interface Holder {
  trader: string;
  shares: string | number;
  usdc_staked: number;
  entry?: number;
}

export interface LivePrice {
  price: string;
  ts: number;
  barrier?: string | null;
  source: string;
}

export interface ChartPoint {
  ts: number;
  price: string;
}

export interface MarketChart {
  market_id: string;
  start_ts: number;
  end_ts: number;
  now_ts: number;
  status: Market["status"];
  barrier: string | null;
  direction?: "up" | "down";
  final: string | null;
  current: string | null;
  winning_side: Side | null;
  points: ChartPoint[];
  source: string;
}

export interface Holders {
  market_id: string;
  yes: Holder[];
  no: Holder[];
}

/** Per-asset display settings from GET /v1/config. */
export interface AssetConfig {
  /** Decimal places for strike and spot formatting (BTC = 0). */
  price_decimals: number;
}

export interface Config {
  chain_id: number;
  exchange: `0x${string}`;
  usdc: `0x${string}`;
  chainlink_btc_usd: `0x${string}`;
  size_decimals?: number;
  size_unit?: number;
  eip712: { name: string; version: string };
  gtd_min_secs?: number;
  tif?: Tif[];
  /** Polymarket-style rate scaled by 1e18 (`7e16` = 0.07). */
  trading_fee_factor?: string;
  /** Absolute USDC raw units for Order.gasFee / settleFill taker gas. */
  gas_fee?: number;
  /** Asset id (lowercase) → display decimals for strikes/spot. */
  assets?: Record<string, AssetConfig>;
}

export interface Version {
  git_sha: string;
  version: string;
}
