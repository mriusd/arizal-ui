import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { toast, ToastContainer } from "react-toastify";
import "react-toastify/dist/ReactToastify.css";
import {
  useAccount,
  useDisconnect,
  usePublicClient,
  useSwitchChain,
  useWriteContract,
} from "wagmi";
import { formatUnits, parseUnits, type Address, type Hex } from "viem";
import { getWalletClient } from "wagmi/actions";
import { api, wsUrl } from "./api/client";
import { centsToDecicents, complementAsk, decicentsToCents, fmtPriceDecicents, MAX_DECICENTS } from "./price";
import type {
  Account,
  Book,
  Config,
  Fill,
  LedgerFund,
  LedgerOrder,
  LedgerPos,
  LedgerTrade,
  Market,
  MarketChart,
  ReferralsReport,
  Side,
  SignedOrder,
  Tif,
} from "./api/types";
import {
  cancelAllMarketId,
  cancelAllTypes,
  cancelTypes,
  domain,
  marketIdHash,
  orderMessage,
  orderTypes,
  resendEmailCodeMessage,
  setEmailMessage,
  setNicknameMessage,
} from "./eip712";
import { exchangeAbi, usdcAbi } from "./abi";
import {
  clearTradingAccount,
  createTradingAccount,
  loadAgentAuth,
  loadTradingAccount,
  saveAgentAuth,
} from "./tradingKey";
import {
  connHealthFromFlags,
  tradingSessionOf,
  type Overlay,
  type PlacePhase,
} from "./state/machines";
import { Tooltip } from "./components/Tooltip";
import { appKit, config, localChain } from "./wagmi";

type TapeEvent = {
  seq?: number;
  ts?: number;
  kind?: string;
  market_id?: string;
  order_id?: number;
  side?: string;
  size?: string | number;
  price?: number;
  trader?: string;
  tif?: string;
  remaining?: string | number;
  reason?: string;
  fill?: Fill;
  fill_id?: number;
  tx_hash?: string;
  op?: string;
  detail?: string;
  winning_side?: string;
  p0?: string;
  p1?: string;
};

function tapeMarketId(e: TapeEvent): string {
  return e.market_id || e.fill?.market_id || "";
}

function fmtShares(raw: string | number | null | undefined, fractionDigits = 6): string {
  if (raw == null || raw === "") return "—";
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return String(raw);
  return n.toLocaleString(undefined, {
    minimumFractionDigits: fractionDigits === 1 ? 1 : 0,
    maximumFractionDigits: fractionDigits,
  });
}

function levelUsd(priceDecicents: number, size: string | number): number {
  const n = typeof size === "number" ? size : Number(size);
  if (!Number.isFinite(n)) return 0;
  return (n * priceDecicents) / 1000;
}

function fmtUsd(n: number): string {
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

type BookLevel = [number, number | string];

function sideBook(book: Book | null, view: Side): { asks: BookLevel[]; bids: BookLevel[] } {
  if (!book) return { asks: [], bids: [] };
  const live = (rows: BookLevel[]) =>
    rows.filter(([, s]) => s !== "" && Number(s) > 0);
  // Best first: asks ascending (lowest ask first), bids descending (highest bid first).
  const bids = live(view === "Yes" ? book.bids_yes || [] : book.bids_no || []).sort(
    (a, b) => Number(b[0]) - Number(a[0])
  );
  const opp = live(view === "Yes" ? book.bids_no || [] : book.bids_yes || []);
  const asks = opp
    .map(([p, sz]) => [1000 - Number(p), sz] as BookLevel)
    .sort((a, b) => a[0] - b[0]);
  return { asks, bids };
}

/** VWAP in decicents walking `levels` (best first) for `want` shares. Null if no liquidity. */
function approxVwapDecicents(levels: BookLevel[], want: number): number | null {
  if (!(want > 0)) {
    const top = levels[0];
    return top ? Number(top[0]) : null;
  }
  let left = want;
  let notional = 0;
  let filled = 0;
  for (const [p, sz] of levels) {
    const avail = Number(sz);
    if (!(avail > 0) || !Number.isFinite(Number(p))) continue;
    const take = Math.min(left, avail);
    notional += take * Number(p);
    filled += take;
    left -= take;
    if (left <= 1e-12) break;
  }
  if (!(filled > 0)) return null;
  return notional / filled;
}

function barrierKey(m: Market): bigint {
  try {
    return BigInt(m.barrier || "0");
  } catch {
    return 0n;
  }
}

type MyFill = {
  id: number;
  marketId: string;
  side: Side;
  price: number;
  yesPrice?: number;
  shares: number;
  ts: number;
  closing?: boolean;
  isTaker?: boolean;
  pnl?: number;
  fee?: number;
  op?: string;
  status?: string;
  txHash?: string;
  logIndex?: number;
  block?: number;
};

/**
 * 30d volume tiers use the Polymarket-style taker fee coefficient (same shape as
 * clearbook `trading_fee_factor / 1e18`), not a flat % of notional:
 *   fee = shares × coefficient × p × (1 − p)
 * with p in dollars. Only the taker pays; makers have no fee.
 */
type FeeTier = { tier: number; minVolume: number; label: string; takerCoeff: number };

const FEE_TIERS: FeeTier[] = [
  { tier: 0, minVolume: 0, label: "Base", takerCoeff: 0.07 },
  { tier: 1, minVolume: 2_000, label: ">$2k", takerCoeff: 0.065 },
  { tier: 2, minVolume: 20_000, label: ">$20k", takerCoeff: 0.06 },
  { tier: 3, minVolume: 200_000, label: ">$200k", takerCoeff: 0.055 },
  { tier: 4, minVolume: 1_000_000, label: ">$1M", takerCoeff: 0.05 },
  { tier: 5, minVolume: 4_000_000, label: ">$4M", takerCoeff: 0.045 },
  { tier: 6, minVolume: 10_000_000, label: ">$10M", takerCoeff: 0.04 },
];

function feeTierForVolume(volumeUsd: number): FeeTier {
  let tier = FEE_TIERS[0];
  for (const t of FEE_TIERS) {
    if (volumeUsd >= t.minVolume) tier = t;
  }
  return tier;
}

function feeTierProgress(volumeUsd: number): {
  current: FeeTier;
  next: FeeTier | null;
  pct: number;
  remaining: number;
} {
  const current = feeTierForVolume(volumeUsd);
  const idx = FEE_TIERS.findIndex((t) => t.minVolume === current.minVolume);
  const next = idx >= 0 && idx < FEE_TIERS.length - 1 ? FEE_TIERS[idx + 1] : null;
  if (!next) return { current, next: null, pct: 100, remaining: 0 };
  const span = next.minVolume - current.minVolume;
  const done = Math.max(0, volumeUsd - current.minVolume);
  const pct = span > 0 ? Math.min(100, (done / span) * 100) : 100;
  return { current, next, pct, remaining: Math.max(0, next.minVolume - volumeUsd) };
}

function fmtVolumeUsd(n: number): string {
  if (!(n > 0)) return "$0";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(n >= 10_000_000 ? 1 : 2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return `$${n.toFixed(0)}`;
}

function fmtTakerFeeCoeff(coeff: number): string {
  return coeff.toFixed(3);
}

type MinePos = {
  marketId: string;
  barrier: string;
  side: Side;
  shares: string | number;
  usdc: number;
  redeemed?: boolean;
};

function fmtUsdNum(n: number): string {
  if (!Number.isFinite(n) || n === 0) return "0";
  const abs = Math.abs(n);
  let dp = 4;
  let body = abs.toFixed(dp);
  while (Number(body) === 0 && dp < 12) {
    dp += 1;
    body = abs.toFixed(dp);
  }
  return body;
}

function fmtSignedUsdNum(n: number): string {
  if (!Number.isFinite(n) || n === 0) return "0";
  const abs = Math.abs(n);
  let dp = abs >= 0.01 ? 4 : 4;
  let body = abs.toFixed(dp);
  while (Number(body) === 0 && dp < 12) {
    dp += 1;
    body = abs.toFixed(dp);
  }
  return `${n < 0 ? "−" : "+"}${body}`;
}

function posEntry(usdc: number, shares: string | number): string {
  const sh = Number(shares);
  if (!(sh > 0) || !Number.isFinite(usdc)) return "—";
  return `${((usdc / 1e6 / sh) * 100).toFixed(2)}¢`;
}

/** Mark mid for a side from Yes mid (¢). */
function sideMidFromYes(yesMid: number | null | undefined, side: Side): number | null {
  if (yesMid == null || !Number.isFinite(yesMid)) return null;
  return side === "Yes" ? yesMid : 100 - yesMid;
}

/** Mark value in USDC dollars at mid ¢. */
function posValueUsd(shares: string | number, midCents: number | null): number | null {
  const sh = Number(shares);
  if (!(sh > 0) || midCents == null) return null;
  return sh * (midCents / 100);
}

function posCostUsd(usdcRaw: number): number {
  return usdcRaw / 1e6;
}

function fmtUsdc(raw: number | string | undefined): string {
  try {
    return formatUnits(BigInt(raw ?? 0), 6);
  } catch {
    return "0";
  }
}

function fmtUsdPlain(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toFixed(2);
}

type MarketsKindTab = "hit" | "above" | "between";
type MarketsTfTab = "daily" | "weekly" | "monthly" | "quarterly";

type TopQuote = { bid: number | null; ask: number | null };

function quotesFromMarkets(ms: Market[]): Record<string, TopQuote> {
  const next: Record<string, TopQuote> = {};
  for (const m of ms) {
    next[m.id] = {
      bid: typeof m.best_yes_bid === "number" ? m.best_yes_bid : null,
      ask: typeof m.best_yes_ask === "number" ? m.best_yes_ask : null,
    };
  }
  return next;
}

function bestBidAsk(book: Book | null | undefined): TopQuote {
  if (!book) return { bid: null, ask: null };
  const live = (rows: BookLevel[]) => rows.filter(([, s]) => s !== "" && Number(s) > 0);
  const yes = live(book.bids_yes || []);
  const no = live(book.bids_no || []);
  const bid = yes.length ? Math.max(...yes.map(([p]) => Number(p))) : null;
  const ask = no.length ? 1000 - Math.max(...no.map(([p]) => Number(p))) : null;
  return { bid: bid != null && Number.isFinite(bid) ? bid : null, ask: ask != null && Number.isFinite(ask) ? ask : null };
}

/** Yes mid in display cents from best bid/ask (book levels are decicents). */
function yesMidCents(book: Book | null | undefined): number | null {
  const { bid, ask } = bestBidAsk(book);
  if (bid == null || ask == null || bid <= 0 || ask <= 0 || ask > 990) return null;
  return (bid + ask) / 20;
}

function centsNum(raw: string | number | null | undefined): number | null {
  if (raw == null || raw === "") return null;
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) ? n : null;
}

function fmtCents(n: number): string {
  return Number.isInteger(n) ? `${n}` : n.toFixed(1);
}

function strikeLabel(m: Market, priceDp = 0): string {
  const kind = m.kind || "hit";
  if (kind === "between" && m.barrier_high) {
    return `${fmtAssetPx(m.barrier, priceDp)}–${fmtAssetPx(m.barrier_high, priceDp)}`;
  }
  const b = fmtAssetPx(m.barrier, priceDp);
  if (kind === "hit") {
    return m.direction === "down" ? `${b} ↓` : `${b} ↑`;
  }
  return b;
}

/** Stable HSL from a string/number key (strike, expiry, …). */
function colorFromValue(key: string | number): string {
  const s = String(key);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const hue = h >>> 0;
  return `hsl(${hue % 360} 52% 42%)`;
}

function pillStyle(color: string): CSSProperties {
  return { ["--pill" as string]: color };
}

const ASSET_PILL_COLOR: Record<string, string> = {
  BTC: "#f7931a",
};

const KIND_PILL_COLOR: Record<string, string> = {
  hit: "#7ec8f5",
  above: "#d2a8f0",
  between: "#5edcc0",
};

const TIMEFRAME_PILL_COLOR: Record<string, string> = {
  daily: "#e8b84a",
  weekly: "#e0922e",
  monthly: "#c48cff",
  quarterly: "#8aa8ff",
};

/** API OrderStatus is snake_case (`resting`); tolerate PascalCase too. */
function isOpenOrderStatus(status: string | undefined): boolean {
  const s = (status || "").toLowerCase();
  return s === "resting" || s === "partial" || s === "accepted";
}

function timeframePillLabel(tf: string): string {
  if (tf === "weekly") return "Weekly";
  if (tf === "monthly") return "Monthly";
  if (tf === "quarterly") return "Quarterly";
  return "Daily";
}

/** Market expiries are America/New_York calendar midnights — format pills in that zone. */
const EXPIRY_TZ = "America/New_York";

function fmtExpiryPill(expiresAt: number | undefined, timeframe?: string): string {
  if (!expiresAt || expiresAt <= 0) return "—";
  const d = new Date(expiresAt * 1000);
  if (timeframe === "quarterly") {
    return d.toLocaleDateString("en-US", { month: "short", year: "2-digit", timeZone: EXPIRY_TZ });
  }
  // daily / weekly / monthly — day + month in ET (e.g. 10 Nov)
  return d.toLocaleDateString("en-US", { day: "numeric", month: "short", timeZone: EXPIRY_TZ });
}

function kindPillLabel(kind: string): string {
  if (kind === "above") return "Above";
  if (kind === "between") return "Between";
  return "Hit";
}

function AssetPill({ market, marketId }: { market?: Market | null; marketId?: string }) {
  const asset = assetLabel(market?.symbol || marketId || "");
  return (
    <span className="mkt-pill" style={pillStyle(ASSET_PILL_COLOR[asset] || colorFromValue(asset))}>
      {asset}
    </span>
  );
}

function KindPill({ market }: { market?: Market | null }) {
  const kind = (market?.kind || "hit").toLowerCase();
  return (
    <span className="mkt-pill" style={pillStyle(KIND_PILL_COLOR[kind] || colorFromValue(kind))}>
      {kindPillLabel(kind)}
    </span>
  );
}

function TimeframePill({ market, timeframe }: { market?: Market | null; timeframe?: string }) {
  const tf = (timeframe || market?.timeframe || "daily").toLowerCase();
  return (
    <span className="mkt-pill" style={pillStyle(TIMEFRAME_PILL_COLOR[tf] || colorFromValue(tf))}>
      {timeframePillLabel(tf)}
    </span>
  );
}

function StrikePill({
  market,
  marketId,
  spotUsd,
  priceDp = 0,
}: {
  market?: Market | null;
  marketId?: string;
  spotUsd?: number | null;
  priceDp?: number;
}) {
  const strike = market ? strikeLabel(market, priceDp) : "—";
  const kind = (market?.kind || "hit").toLowerCase();
  const strikeUp = "#2a8a58";
  const strikeDown = "#a84a42";
  let color = "#8a969e";
  if (kind === "hit") {
    color = market?.direction === "down" ? strikeDown : strikeUp;
  } else {
    const level = strikeUsd(market);
    if (spotUsd != null && level != null) {
      color = spotUsd >= level ? strikeUp : strikeDown;
    }
  }
  return (
    <span className="mkt-pill" style={pillStyle(color)} title={marketId}>
      {strike}
    </span>
  );
}

function expiryPillColor(expiresAt: number | undefined, nowSec: number): string {
  if (!expiresAt || expiresAt <= 0) return "#8a969e";
  const left = expiresAt - nowSec;
  if (left < 24 * 3600) return "#a84a42";
  if (left < 72 * 3600) return "#a07a12";
  return "#2a8a58";
}

function fmtExpiryRemaining(expiresAt: number | undefined, nowSec: number): string | null {
  if (!expiresAt || expiresAt <= 0) return null;
  const left = expiresAt - nowSec;
  if (left <= 0) return null;
  if (left < 24 * 3600) return `${Math.max(1, Math.ceil(left / 3600))}H`;
  return `${Math.floor(left / (24 * 3600))}D`;
}

function fmtExpiryTs(expiresAt: number, timeZone?: string): string {
  return new Date(expiresAt * 1000).toLocaleString("en-US", {
    timeZone,
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

function fmtExpiryCountdown(expiresAt: number, nowSec: number): string {
  const left = expiresAt - nowSec;
  if (left <= 0) return "expired";
  const d = Math.floor(left / 86400);
  const h = Math.floor((left % 86400) / 3600);
  const m = Math.floor((left % 3600) / 60);
  return `${d}d ${h}h ${m}m`;
}

function expiryTooltipContent(expiresAt: number, nowSec: number): ReactNode {
  return (
    <>
      <div>
        {fmtExpiryTs(expiresAt, EXPIRY_TZ)} ({EXPIRY_TZ})
      </div>
      <div>{fmtExpiryTs(expiresAt)} (local)</div>
      <div>{fmtExpiryCountdown(expiresAt, nowSec)} left</div>
    </>
  );
}

function ExpiryPill({
  market,
  marketId,
  expiresAt,
  nowSec,
  showRemaining = true,
}: {
  market?: Market | null;
  marketId?: string;
  expiresAt?: number;
  nowSec?: number;
  showRemaining?: boolean;
}) {
  const ts = expiresAt ?? market?.expires_at;
  const now = nowSec ?? Math.floor(Date.now() / 1000);
  const [tipNow, setTipNow] = useState<number | null>(null);
  const tipActive = tipNow != null;
  useEffect(() => {
    if (!tipActive) return;
    const id = window.setInterval(() => setTipNow(Math.floor(Date.now() / 1000)), 1000);
    return () => window.clearInterval(id);
  }, [tipActive]);
  const expiry = fmtExpiryPill(ts, market?.timeframe);
  const remaining = showRemaining ? fmtExpiryRemaining(ts, now) : null;
  const hasExpiry = !!ts && ts > 0;
  const tipClock = tipNow ?? Math.floor(Date.now() / 1000);
  const pill = (
    <span className="mkt-pill" style={pillStyle(expiryPillColor(ts, now))} title={hasExpiry ? undefined : marketId}>
      {remaining ? `${expiry} ${remaining}` : expiry}
    </span>
  );
  if (!hasExpiry || !ts) return pill;
  return (
    <span
      className="mkt-pill-tip-wrap"
      onMouseEnter={() => setTipNow(Math.floor(Date.now() / 1000))}
      onMouseLeave={() => setTipNow(null)}
      onFocusCapture={() => setTipNow(Math.floor(Date.now() / 1000))}
      onBlurCapture={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setTipNow(null);
      }}
    >
      <Tooltip content={expiryTooltipContent(ts, tipClock)} className="mkt-pill-tip">
        {pill}
      </Tooltip>
    </span>
  );
}

/** [ASSET] [KIND] [TIMEFRAME] [STRIKE] [EXPIRY] for lists / titles. */
function MarketTitlePills({
  market,
  marketId,
  spotUsd,
  nowSec,
  priceDp = 0,
}: {
  market?: Market | null;
  marketId: string;
  spotUsd?: number | null;
  nowSec?: number;
  priceDp?: number;
}) {
  return (
    <span className="mkt-pills" title={marketId}>
      <AssetPill market={market} marketId={marketId} />
      <KindPill market={market} />
      <TimeframePill market={market} />
      <StrikePill market={market} marketId={marketId} spotUsd={spotUsd} priceDp={priceDp} />
      <ExpiryPill market={market} marketId={marketId} nowSec={nowSec} />
    </span>
  );
}

function strikeSortKey(m: Market): bigint {
  return barrierKey(m);
}

function marketRowKey(m: Market): string {
  const kind = m.kind || "hit";
  if (kind === "between") return `between:${m.barrier}:${m.barrier_high || ""}`;
  if (kind === "hit") return `hit:${m.barrier}:${m.direction}`;
  return `above:${m.barrier}`;
}

/** Compact share count for market-grid position pills. */
function fmtGridShares(raw: string | number): string {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!(n > 0) || !Number.isFinite(n)) return "";
  if (n >= 100) return n.toFixed(0);
  if (n >= 10) return n.toFixed(1);
  return n.toFixed(2).replace(/\.?0+$/, "");
}

type GridOrderMark = { price: number; rem: number; buy: boolean };
type GridMine = {
  yesPos?: number;
  noPos?: number;
  yesOrders: GridOrderMark[];
  noOrders: GridOrderMark[];
};

function buildGridMine(positions: MinePos[], orders: LedgerOrder[]): Record<string, GridMine> {
  const out: Record<string, GridMine> = {};
  const slot = (id: string): GridMine => {
    let g = out[id];
    if (!g) {
      g = { yesOrders: [], noOrders: [] };
      out[id] = g;
    }
    return g;
  };
  for (const p of positions) {
    const n = Number(p.shares);
    if (!(n > 0)) continue;
    const g = slot(p.marketId);
    if (p.side === "Yes") g.yesPos = (g.yesPos || 0) + n;
    else g.noPos = (g.noPos || 0) + n;
  }
  for (const o of orders) {
    if (!isOpenOrderStatus(o.status)) continue;
    const rem = Number(o.remaining);
    if (!(rem > 0)) continue;
    const px = Number(o.price);
    if (!Number.isFinite(px)) continue;
    // Open book rows are buys (sells do not rest). Keep buy/sell for color if that changes.
    const mark: GridOrderMark = { price: px, rem, buy: true };
    const g = slot(o.market_id);
    if (o.side === "Yes") g.yesOrders.push(mark);
    else g.noOrders.push(mark);
  }
  // One pill per side for the highest buy and highest sell only.
  const bestOf = (marks: GridOrderMark[]): GridOrderMark[] => {
    let buy: GridOrderMark | undefined;
    let sell: GridOrderMark | undefined;
    for (const m of marks) {
      if (m.buy) {
        if (!buy || m.price > buy.price) buy = m;
      } else if (!sell || m.price > sell.price) {
        sell = m;
      }
    }
    const next: GridOrderMark[] = [];
    if (buy) next.push(buy);
    if (sell) next.push(sell);
    next.sort((a, b) => b.price - a.price);
    return next;
  };
  for (const g of Object.values(out)) {
    g.yesOrders = bestOf(g.yesOrders);
    g.noOrders = bestOf(g.noOrders);
  }
  return out;
}

const MarketHistory = memo(function MarketHistory({
  rows,
  mid,
  spotUsd,
  nowSec,
  quotes,
  onOpen,
  marketsTab,
  onMarketsTab,
  marketsTf,
  onMarketsTf,
  mine,
  priceDp = 0,
}: {
  rows: Market[];
  mid: string;
  spotUsd: number | null;
  nowSec: number;
  quotes: Record<string, TopQuote>;
  onOpen: (id: string, side: Side) => void;
  marketsTab: MarketsKindTab;
  onMarketsTab: (tab: MarketsKindTab) => void;
  marketsTf: MarketsTfTab;
  onMarketsTf: (tab: MarketsTfTab) => void;
  mine: Record<string, GridMine>;
  priceDp?: number;
}) {
  const kind = marketsTab;
  const live = useMemo(
    () =>
      rows.filter(
        (m) =>
          m.status !== "Resolved" &&
          (m.kind || "hit") === kind &&
          (m.timeframe || "daily") === marketsTf
      ),
    [rows, kind, marketsTf]
  );

  const expiries = useMemo(() => {
    const set = new Set<number>();
    for (const m of live) {
      if (m.expires_at && m.expires_at > 0) set.add(m.expires_at);
    }
    return [...set].sort((a, b) => a - b);
  }, [live]);

  const strikeRows = useMemo(() => {
    const map = new Map<string, { key: string; sample: Market; sort: bigint; byExp: Map<number, Market> }>();
    for (const m of live) {
      const key = marketRowKey(m);
      const exp = m.expires_at && m.expires_at > 0 ? m.expires_at : null;
      if (exp == null) continue;
      let row = map.get(key);
      if (!row) {
        row = { key, sample: m, sort: strikeSortKey(m), byExp: new Map() };
        map.set(key, row);
      }
      row.byExp.set(exp, m);
    }
    return [...map.values()].sort((a, b) =>
      a.sort < b.sort
        ? 1
        : a.sort > b.sort
          ? -1
          : strikeLabel(a.sample, priceDp) < strikeLabel(b.sample, priceDp)
            ? -1
            : 1
    );
  }, [live, priceDp]);

  // Top-of-book from the quotes map (updated in place on WS `quote` — not via remapping markets).
  const spotLineRef = useRef<HTMLTableRowElement>(null);

  // Rows are high→low. Insert the spot marker before the first strike at or below spot.
  const spotInsertAt = useMemo(() => {
    if (spotUsd == null || strikeRows.length === 0) return -1;
    for (let i = 0; i < strikeRows.length; i++) {
      const level = strikeUsd(strikeRows[i].sample);
      if (level != null && level <= spotUsd) return i;
    }
    return strikeRows.length;
  }, [spotUsd, strikeRows]);

  useEffect(() => {
    if (spotInsertAt < 0) return;
    const id = requestAnimationFrame(() => {
      const el = spotLineRef.current;
      if (!el) return;
      const scroller = el.closest(".mkt-scroll") as HTMLElement | null;
      if (!scroller) return;
      const sRect = scroller.getBoundingClientRect();
      const eRect = el.getBoundingClientRect();
      const center = eRect.top - sRect.top + scroller.scrollTop + eRect.height / 2;
      scroller.scrollTop = center - scroller.clientHeight / 2;
    });
    return () => cancelAnimationFrame(id);
  }, [spotInsertAt, kind, marketsTf, strikeRows.length]);

  const colSpan = Math.max(1, expiries.length) + 1;
  const spotLine =
    spotInsertAt >= 0 ? (
      <tr key="spot-line" className="spot-line" ref={spotLineRef}>
        <td colSpan={colSpan}>
          <div className="spot-rule" aria-label="spot" />
        </td>
      </tr>
    ) : null;

  return (
    <div className="market-grid">
      <div className="book-head">
        <h2>Markets</h2>
        <div className="tabs mkt-pill-tabs">
          {(["hit", "above", "between"] as const).map((k) => (
            <button
              key={k}
              type="button"
              className={`mkt-pill mkt-pill-tab${kind === k ? " active" : ""}`}
              style={pillStyle(KIND_PILL_COLOR[k])}
              onClick={() => onMarketsTab(k)}
            >
              {kindPillLabel(k)}
            </button>
          ))}
          <span className="tab-sep" aria-hidden="true" />
          {(["daily", "weekly", "monthly", "quarterly"] as const).map((t) => (
            <button
              key={t}
              type="button"
              className={`mkt-pill mkt-pill-tab${marketsTf === t ? " active" : ""}`}
              style={pillStyle(TIMEFRAME_PILL_COLOR[t])}
              onClick={() => onMarketsTf(t)}
            >
              {timeframePillLabel(t)}
            </button>
          ))}
        </div>
      </div>
      <div className="mkt-scroll">
        <table className="mkt-matrix">
          <thead>
            <tr>
              <th className="left">strike</th>
              {expiries.map((e) => (
                <th key={e}>
                  <ExpiryPill expiresAt={e} nowSec={nowSec} market={{ timeframe: marketsTf } as Market} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {strikeRows.map((row, i) => (
              <Fragment key={row.key}>
                {i === spotInsertAt ? spotLine : null}
                <tr>
                  <td className="left strike">
                    <StrikePill market={row.sample} marketId={row.sample.id} spotUsd={spotUsd} priceDp={priceDp} />
                  </td>
                  {expiries.map((e) => {
                    const m = row.byExp.get(e);
                    if (!m) {
                      return (
                        <td key={e} className="empty">
                          —
                        </td>
                      );
                    }
                    const q = quotes[m.id];
                    const g = mine[m.id];
                    // Best Yes ask / best No ask (No ask = 100¢ − best Yes bid; prices are decicents).
                    return (
                      <td key={e} className={m.id === mid ? "me quote" : "quote"} title={m.id}>
                        <div className="quote-wrap">
                          {g && g.yesOrders.length > 0 && (
                            <div className="cell-orders yes" aria-label="Yes orders">
                              {g.yesOrders.map((o, i) => (
                                <span
                                  key={`y${o.price}-${i}`}
                                  className={`ord-pill ${o.buy ? "buy" : "sell"}`}
                                  title={`${o.buy ? "Buy" : "Sell"} Yes ${fmtPriceDecicents(o.price)}¢ × ${fmtGridShares(o.rem)}`}
                                >
                                  {fmtPriceDecicents(o.price)}
                                </span>
                              ))}
                            </div>
                          )}
                          {g && g.noOrders.length > 0 && (
                            <div className="cell-orders no" aria-label="No orders">
                              {g.noOrders.map((o, i) => (
                                <span
                                  key={`n${o.price}-${i}`}
                                  className={`ord-pill ${o.buy ? "buy" : "sell"}`}
                                  title={`${o.buy ? "Buy" : "Sell"} No ${fmtPriceDecicents(o.price)}¢ × ${fmtGridShares(o.rem)}`}
                                >
                                  {fmtPriceDecicents(o.price)}
                                </span>
                              ))}
                            </div>
                          )}
                          <div className="quote-cell">
                            <button type="button" className="bid" onClick={() => onOpen(m.id, "Yes")}>
                              {q?.ask != null ? (
                                fmtPriceDecicents(q.ask)
                              ) : (
                                <span className="na" aria-label="no yes ask" />
                              )}
                            </button>
                            <span className="sep">/</span>
                            <button type="button" className="ask" onClick={() => onOpen(m.id, "No")}>
                              {q?.bid != null ? (
                                fmtPriceDecicents(complementAsk(q.bid))
                              ) : (
                                <span className="na" aria-label="no no ask" />
                              )}
                            </button>
                          </div>
                          {g && ((g.yesPos != null && g.yesPos > 0) || (g.noPos != null && g.noPos > 0)) && (
                            <div className="cell-pos">
                              {g.yesPos != null && g.yesPos > 0 && (
                                <span className="pos-pill yes" title={`Yes ${fmtGridShares(g.yesPos)}`}>
                                  {fmtGridShares(g.yesPos)}
                                </span>
                              )}
                              {g.noPos != null && g.noPos > 0 && (
                                <span className="pos-pill no" title={`No ${fmtGridShares(g.noPos)}`}>
                                  {fmtGridShares(g.noPos)}
                                </span>
                              )}
                            </div>
                          )}
                        </div>
                      </td>
                    );
                  })}
                </tr>
              </Fragment>
            ))}
            {spotInsertAt === strikeRows.length ? spotLine : null}
            {strikeRows.length === 0 && (
              <tr>
                <td className="left" colSpan={colSpan}>
                  no {kind} markets
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
});

const MarketPicker = memo(function MarketPicker({
  market,
  quote,
  spotRaw,
  nowSec,
  open,
  onToggle,
  rows,
  quotes,
  marketsTab,
  onMarketsTab,
  marketsTf,
  onMarketsTf,
  onOpen,
  mine,
  priceDp = 0,
}: {
  market: Market | null;
  quote: TopQuote;
  quotes: Record<string, TopQuote>;
  spotRaw: string | null;
  nowSec: number;
  open: boolean;
  onToggle: () => void;
  rows: Market[];
  marketsTab: MarketsKindTab;
  onMarketsTab: (tab: MarketsKindTab) => void;
  marketsTf: MarketsTfTab;
  onMarketsTf: (tab: MarketsTfTab) => void;
  onOpen: (id: string, side: Side) => void;
  mine: Record<string, GridMine>;
  priceDp?: number;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) onToggle();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onToggle();
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onToggle]);

  const spot = pxToUsd(spotRaw);
  const strike = strikeUsd(market);
  const deltaPct =
    spot != null && strike != null && strike !== 0 ? ((spot - strike) / strike) * 100 : null;
  const deltaCls = deltaPct == null ? "" : deltaPct > 0 ? "yes" : deltaPct < 0 ? "no" : "";

  return (
    <div className={`market-picker${open ? " open" : ""}`} ref={wrapRef}>
      <button type="button" className="market-bar" onClick={onToggle} aria-expanded={open}>
        <div className="market-bar-cell">
          <span className="lbl">Asset</span>
          <span className="val">
            <AssetPill market={market} marketId={market?.id} />
          </span>
        </div>
        <div className="market-bar-cell">
          <span className="lbl">Kind</span>
          <span className="val">
            <KindPill market={market} />
          </span>
        </div>
        <div className="market-bar-cell">
          <span className="lbl">Timeframe</span>
          <span className="val">
            <TimeframePill market={market} />
          </span>
        </div>
        <div className="market-bar-cell">
          <span className="lbl">Strike</span>
          <span className="val">
            <StrikePill market={market} marketId={market?.id} spotUsd={spot} priceDp={priceDp} />
          </span>
        </div>
        <div className="market-bar-cell">
          <span className="lbl">Yes / No</span>
          <span className="val market-bar-quote">
            <span className="bid">{quote.bid != null ? fmtPriceDecicents(quote.bid) : "—"}</span>
            <span className="sep">/</span>
            <span className="ask">{quote.ask != null ? fmtPriceDecicents(complementAsk(quote.ask)) : "—"}</span>
          </span>
        </div>
        <div className="market-bar-cell">
          <span className="lbl">Spot</span>
          <span className="val">{fmtSpotUsd(spot, priceDp)}</span>
        </div>
        <div className="market-bar-cell">
          <span className="lbl">Δ spot</span>
          <span className={`val ${deltaCls}`}>
            {deltaPct == null ? "—" : `${deltaPct > 0 ? "+" : ""}${deltaPct.toFixed(2)}%`}
          </span>
        </div>
        <div className="market-bar-cell">
          <span className="lbl">Expires</span>
          <span className="val market-bar-expiry">
            <ExpiryPill market={market} marketId={market?.id} nowSec={nowSec} />
          </span>
        </div>
        <span className="market-chev" aria-hidden>
          {open ? "▴" : "▾"}
        </span>
      </button>
      {open && (
        <div className="market-drop">
          <MarketHistory
            rows={rows}
            mid={market?.id || ""}
            spotUsd={spot}
            nowSec={nowSec}
            quotes={quotes}
            marketsTab={marketsTab}
            onMarketsTab={onMarketsTab}
            marketsTf={marketsTf}
            onMarketsTf={onMarketsTf}
            onOpen={onOpen}
            mine={mine}
            priceDp={priceDp}
          />
        </div>
      )}
    </div>
  );
});

const CHART_TF = [
  ["5m", 5 * 60],
  ["1h", 60 * 60],
  ["1d", 24 * 60 * 60],
  ["30d", 30 * 24 * 60 * 60],
] as const;
type ChartTf = (typeof CHART_TF)[number][0];

const UI_PREFS_KEY = "clearbook.ui";

type MineTab = "positions" | "orders" | "history" | "funds";

/** Limit-order expiry preset in the place panel. */
type ExpiryChoice = "never" | "5m" | "1h" | "12h" | "24h" | "custom" | "saved";

type CustomExpiry = {
  /** Cancel this many seconds before market expiry. */
  mode: "before_market" | "absolute";
  beforeSecs: number;
  /** Absolute unix seconds (local calendar). */
  atUnix: number;
};

type UiPrefs = {
  mineTab: MineTab;
  chartTf: ChartTf;
  marketsTab: MarketsKindTab;
  marketsTf: MarketsTfTab;
  side: Side;
  intent: "buy" | "sell";
  entryKind: "limit" | "market" | "merge" | "split";
  price: number;
  size: string;
  expiryChoice: ExpiryChoice;
  savedExpiry: CustomExpiry | null;
};

const EXPIRY_PRESET_SECS: Record<"5m" | "1h" | "12h" | "24h", number> = {
  "5m": 5 * 60,
  "1h": 60 * 60,
  "12h": 12 * 60 * 60,
  "24h": 24 * 60 * 60,
};

function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

function defaultCustomExpiry(nowSec = Math.floor(Date.now() / 1000)): CustomExpiry {
  return { mode: "before_market", beforeSecs: 5 * 3600, atUnix: nowSec + 3600 };
}

function parseCustomExpiry(v: unknown, fallback: CustomExpiry): CustomExpiry {
  if (!v || typeof v !== "object") return fallback;
  const o = v as Partial<CustomExpiry>;
  const mode = o.mode === "absolute" ? "absolute" : "before_market";
  const beforeSecs = Number(o.beforeSecs);
  const atUnix = Number(o.atUnix);
  return {
    mode,
    beforeSecs: Number.isFinite(beforeSecs) && beforeSecs >= 0 ? Math.floor(beforeSecs) : fallback.beforeSecs,
    atUnix: Number.isFinite(atUnix) && atUnix > 0 ? Math.floor(atUnix) : fallback.atUnix,
  };
}

function fmtDurationSecs(secs: number): string {
  const s = Math.max(0, Math.floor(secs));
  if (s === 0) return "0m";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0 && m > 0) return `${h}h ${m}m`;
  if (h > 0) return `${h}h`;
  return `${m}m`;
}

function fmtCustomExpiryLabel(c: CustomExpiry): string {
  if (c.mode === "before_market") return `${fmtDurationSecs(c.beforeSecs)} before expiry`;
  return new Date(c.atUnix * 1000).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function toDatetimeLocalValue(unix: number): string {
  const d = new Date(unix * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromDatetimeLocalValue(s: string): number {
  const t = Date.parse(s);
  return Number.isFinite(t) ? Math.floor(t / 1000) : 0;
}

function resolveLimitExpiry(
  choice: ExpiryChoice,
  applied: CustomExpiry | null,
  saved: CustomExpiry | null,
  marketExpiresAt: number | undefined,
  nowSec: number
): { tif: Tif; expiresAt: number } {
  if (choice === "never") return { tif: "GTC", expiresAt: 0 };
  if (choice === "5m" || choice === "1h" || choice === "12h" || choice === "24h") {
    return { tif: "GTD", expiresAt: nowSec + EXPIRY_PRESET_SECS[choice] };
  }
  const cfg = choice === "saved" ? saved : applied;
  if (!cfg) return { tif: "GTC", expiresAt: 0 };
  if (cfg.mode === "before_market") {
    const mkt = marketExpiresAt && marketExpiresAt > 0 ? marketExpiresAt : 0;
    if (!mkt) throw new Error("market expiry unknown — pick a date/time or wait for market data");
    return { tif: "GTD", expiresAt: mkt - cfg.beforeSecs };
  }
  return { tif: "GTD", expiresAt: cfg.atUnix };
}

function readUiPrefs(): UiPrefs {
  const d: UiPrefs = {
    mineTab: "orders",
    chartTf: "5m",
    marketsTab: "hit",
    marketsTf: "daily",
    side: "Yes",
    intent: "buy",
    entryKind: "limit",
    price: 60,
    size: "10",
    expiryChoice: "never",
    savedExpiry: null,
  };
  try {
    const raw = localStorage.getItem(UI_PREFS_KEY);
    if (!raw) return d;
    const v = JSON.parse(raw) as Partial<UiPrefs> & { tif?: string };
    const price = Number(v.price);
    const savedExpiry = v.savedExpiry ? parseCustomExpiry(v.savedExpiry, defaultCustomExpiry()) : null;
    let expiryChoice = oneOf(
      v.expiryChoice,
      ["never", "5m", "1h", "12h", "24h", "custom", "saved"],
      d.expiryChoice
    );
    // Migrate legacy GTC/GTD prefs.
    if (v.expiryChoice == null && typeof v.tif === "string") {
      expiryChoice = v.tif === "GTD" ? "1h" : "never";
    }
    if (expiryChoice === "saved" && !savedExpiry) expiryChoice = "never";
    if (expiryChoice === "custom") expiryChoice = "never";
    return {
      mineTab: oneOf(
        (v.mineTab as string | undefined) === "trades" ? "history" : v.mineTab,
        ["positions", "orders", "history", "funds"],
        d.mineTab
      ),
      chartTf: oneOf(v.chartTf, ["5m", "1h", "1d", "30d"], d.chartTf),
      marketsTab: oneOf(v.marketsTab, ["hit", "above", "between"], d.marketsTab),
      marketsTf: oneOf(v.marketsTf, ["daily", "weekly", "monthly", "quarterly"], d.marketsTf),
      side: oneOf(v.side, ["Yes", "No"], d.side),
      intent: oneOf(v.intent, ["buy", "sell"], d.intent),
      entryKind: oneOf(v.entryKind, ["limit", "market", "merge", "split"], d.entryKind),
      price: Number.isInteger(price) && price >= 1 && price <= 99 ? price : d.price,
      size: typeof v.size === "string" && v.size.length > 0 && v.size.length <= 32 ? v.size : d.size,
      expiryChoice,
      savedExpiry,
    };
  } catch {
    return d;
  }
}

function fmtChartTick(ts: number, spanSec: number): string {
  const d = new Date(ts * 1000);
  if (spanSec >= 24 * 60 * 60) {
    return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  }
  if (spanSec >= 60 * 60) {
    return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** Even time ticks across [start, end], including endpoints (~max interior steps). */
function chartTimeTicks(start: number, end: number, maxInterior = 5): number[] {
  const span = Math.max(1, end - start);
  const steps = [30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400, 172800, 604800];
  let step = steps[steps.length - 1];
  for (const c of steps) {
    if (span / c <= maxInterior + 1) {
      step = c;
      break;
    }
  }
  const ticks: number[] = [start];
  const first = Math.ceil((start + 1e-9) / step) * step;
  for (let t = first; t < end - step * 0.25; t += step) {
    if (t > start + step * 0.2) ticks.push(t);
  }
  ticks.push(end);
  return ticks;
}

function shortTx(tx?: string): string {
  if (!tx || !tx.startsWith("0x") || tx.length < 12) return "—";
  return `${tx.slice(0, 10)}…`;
}

function shortAddr(addr?: string): string {
  if (!addr || addr.length < 10) return "—";
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

const REFERRER_STORAGE_KEY = "arizal.referrer";

function isWalletAddress(s: string): s is `0x${string}` {
  return /^0x[a-fA-F0-9]{40}$/.test(s);
}

/** Capture `?r=` / `?ref=` / `?referrer=` into localStorage; return the pending referrer if any. */
function captureReferrerFromUrl(): string | null {
  try {
    const q = new URLSearchParams(window.location.search);
    const raw = (q.get("r") || q.get("ref") || q.get("referrer") || "").trim();
    if (isWalletAddress(raw)) {
      localStorage.setItem(REFERRER_STORAGE_KEY, raw.toLowerCase());
    }
  } catch {
    /* private mode */
  }
  try {
    const stored = localStorage.getItem(REFERRER_STORAGE_KEY);
    if (stored && isWalletAddress(stored)) return stored.toLowerCase();
  } catch {
    /* ignore */
  }
  return null;
}

function clearStoredReferrer() {
  try {
    localStorage.removeItem(REFERRER_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

/** Shareable referral URL for `trader` (`https://host/?r=0x…`, no market path). */
function referralLinkFor(trader: string): string {
  const u = new URL("/", window.location.origin);
  u.searchParams.set("r", trader.toLowerCase());
  return u.toString();
}

/** Deterministic jazzicon-style glyph from a wallet address. */
function WalletGlyph({ address, size = 22 }: { address: string; size?: number }) {
  const seed = address.toLowerCase().replace(/^0x/, "").padEnd(40, "0");
  const n = (i: number) => parseInt(seed.slice((i * 2) % 38, (i * 2) % 38 + 2) || "00", 16);
  const c1 = `hsl(${n(0) % 360} 58% 46%)`;
  const c2 = `hsl(${n(3) % 360} 52% 40%)`;
  const c3 = `hsl(${n(6) % 360} 62% 55%)`;
  const rot = n(9) % 360;
  const cx = 8 + (n(12) % 16);
  const cy = 8 + (n(15) % 16);
  const r = 5 + (n(18) % 7);
  return (
    <svg className="wallet-glyph" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <circle cx="16" cy="16" r="16" fill={c1} />
      <g transform={`rotate(${rot} 16 16)`}>
        <path d="M16 0A16 16 0 0 1 16 32Z" fill={c2} />
        <circle cx={cx} cy={cy} r={r} fill={c3} opacity="0.9" />
      </g>
    </svg>
  );
}

function fmtResolvedAt(ts?: number | null): string {
  if (!ts) return "—";
  return new Date(ts * 1000).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function fmtLocalTime(ts: number | undefined): string {
  if (!ts) return "—";
  return new Date(ts * 1000).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function fmtLocalDateTime(ts: number | undefined): string {
  if (!ts) return "—";
  return new Date(ts * 1000).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

const RESERVED_PATHS = new Set(["docs", "docs.html", "index.html"]);

function marketIdFromPath(path: string): string {
  const p = path.replace(/^\/+|\/+$/g, "");
  if (!p || RESERVED_PATHS.has(p) || p.startsWith("docs/")) return "";
  return p;
}

/** Asset id from market id / symbol (`btc-hit-…` → `btc`). */
function marketAsset(m?: { id?: string; symbol?: string } | null): string {
  const raw = (m?.symbol || m?.id || "btc").toLowerCase();
  const head = raw.split(/[-_]/)[0];
  return head || "btc";
}

/** Display decimals for an asset from GET /v1/config (`assets.<id>.price_decimals`). */
function priceDpFor(cfg: Config | null | undefined, asset = "btc"): number {
  const row = cfg?.assets?.[asset.toLowerCase()] ?? cfg?.assets?.btc;
  const n = row?.price_decimals;
  return typeof n === "number" && n >= 0 ? Math.min(18, Math.floor(n)) : 0;
}

/** Format oracle/barrier fixed-point using the asset's configured decimal places. */
function fmtAssetPx(raw: string | number | null | undefined, dp = 0): string {
  const n = pxToUsd(raw);
  if (n == null) return "—";
  const neg = n < 0;
  const body = Math.abs(n).toLocaleString(undefined, {
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
  });
  return `${neg ? "-" : ""}${body}`;
}

function fmtSpotUsd(n: number | null | undefined, dp = 0): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `$${n.toLocaleString(undefined, {
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
  })}`;
}

/** USD number from 8- or 18-decimal chain/oracle fixed-point. */
function pxToUsd(raw: string | number | null | undefined): number | null {
  if (raw == null || raw === "") return null;
  let x: bigint;
  try {
    x = BigInt(typeof raw === "number" ? Math.trunc(raw).toString() : raw);
  } catch {
    return null;
  }
  const neg = x < 0n;
  const a = neg ? -x : x;
  const n = a > 10n ** 12n ? Number(a) / 1e18 : Number(a) / 1e8;
  if (!Number.isFinite(n)) return null;
  return neg ? -n : n;
}

/** Default landing market: soonest open daily hit-up, barrier closest to spot (else lowest rung). */
function pickDefaultMarket(ms: Market[], spotUsd: number | null): Market | undefined {
  const hits = ms.filter(
    (m) =>
      m.status === "Open" &&
      (m.kind || "hit") === "hit" &&
      (m.timeframe || "daily") === "daily" &&
      (m.direction || "up") === "up"
  );
  if (hits.length === 0) return undefined;
  let soonest = Number(hits[0].expires_at || 0);
  for (const m of hits) {
    const exp = Number(m.expires_at || 0);
    if (exp > 0 && (soonest <= 0 || exp < soonest)) soonest = exp;
  }
  const today = hits.filter((m) => Number(m.expires_at || 0) === soonest);
  let best = today[0];
  let bestDist = Number.POSITIVE_INFINITY;
  for (const m of today) {
    const b = pxToUsd(m.barrier);
    if (b == null) continue;
    const dist = spotUsd != null ? Math.abs(b - spotUsd) : b;
    if (dist < bestDist) {
      bestDist = dist;
      best = m;
    }
  }
  return best;
}

function strikeUsd(m: Market | null | undefined): number | null {
  if (!m) return null;
  const lo = pxToUsd(m.barrier);
  if (lo == null) return null;
  if ((m.kind || "hit") === "between" && m.barrier_high) {
    const hi = pxToUsd(m.barrier_high);
    if (hi == null) return lo;
    return (lo + hi) / 2;
  }
  return lo;
}

/** Matches node `market_resolved_key` (kind + barrier [+ high] + expiry; hit ignores up/down). */
function marketResolvedKey(m: Market | null | undefined): string | null {
  if (!m) return null;
  const lo = pxToUsd(m.barrier);
  if (lo == null) return null;
  const barrier = Math.floor(lo).toString();
  const kind = m.kind || "hit";
  const exp = m.expires_at ?? 0;
  if (kind === "hit") return `hit:${barrier}:${exp}`;
  if (kind === "above") return `above:${barrier}:${exp}`;
  const hiRaw = pxToUsd(m.barrier_high);
  const hi = hiRaw == null ? barrier : Math.floor(hiRaw).toString();
  return `between:${barrier}:${hi}:${exp}`;
}

function fmtCountdown(expiresAt: number | undefined, now: number): string {
  if (!expiresAt || expiresAt <= 0) return "—";
  let s = Math.max(0, expiresAt - now);
  if (s === 0) return "expired";
  const d = Math.floor(s / 86400);
  s %= 86400;
  const h = Math.floor(s / 3600);
  s %= 3600;
  const m = Math.floor(s / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${h}h ${m.toString().padStart(2, "0")}m`;
  return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}:${sec.toString().padStart(2, "0")}`;
}

/** >1d green, <1d yellow, <8h red. */
function countdownTone(expiresAt: number | undefined, now: number): "ok" | "warn" | "hot" | "muted" {
  if (!expiresAt || expiresAt <= 0) return "muted";
  const left = expiresAt - now;
  if (left <= 0) return "hot";
  if (left < 8 * 3600) return "hot";
  if (left < 24 * 3600) return "warn";
  return "ok";
}

/** Second-precision countdown isolated so the rest of the app need not re-render at 1Hz. */
const LiveCountdown = memo(function LiveCountdown({
  expiresAt,
  className,
  title,
}: {
  expiresAt: number | undefined;
  className?: string;
  title?: string;
}) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    if (!expiresAt || expiresAt <= 0) return;
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, [expiresAt]);
  const tone = countdownTone(expiresAt, now);
  const cls = [className, className?.includes("chart-countdown") ? tone : null].filter(Boolean).join(" ");
  return (
    <span className={cls || undefined} title={title}>
      {fmtCountdown(expiresAt, now)}
    </span>
  );
});

/** Compact time-to-expiry: `3d` when ≥1d, else `5h`. */
function fmtExpLeft(expiresAt: number | undefined, now: number): string {
  if (!expiresAt || expiresAt <= 0) return "—";
  const s = Math.max(0, expiresAt - now);
  if (s <= 0) return "0h";
  if (s >= 86400) return `${Math.floor(s / 86400)}d`;
  return `${Math.max(1, Math.ceil(s / 3600))}h`;
}

/** Order expiry left: `3h`, or minutes when under 1h (`12m`). */
function fmtOrderExpiresLeft(expiresAt: number, now: number): string {
  const s = Math.max(0, expiresAt - now);
  if (s <= 0) return "0m";
  if (s >= 3600) return `${Math.floor(s / 3600)}h`;
  return `${Math.max(1, Math.ceil(s / 60))}m`;
}

function assetLabel(symbol: string | undefined): string {
  if (!symbol) return "BTC";
  const s = symbol.toUpperCase();
  if (s.startsWith("BTC")) return "BTC";
  return s.split(/[-_/]/)[0] || s;
}

export function App() {
  const { address: trader, isConnected, chainId: walletChainId } = useAccount();
  const walletOn = isConnected;
  const { disconnect } = useDisconnect();
  const { switchChainAsync } = useSwitchChain();
  const publicClient = usePublicClient({ chainId: localChain.id });
  const { writeContractAsync: writeInjected } = useWriteContract();
  const onHardhat = walletChainId === localChain.id;
  /** Browser session key + stored ApproveAgent are present and unexpired. */
  const [tradingEnabled, setTradingEnabled] = useState(false);

  const [cfg, setCfg] = useState<Config | null>(null);
  const [markets, setMarkets] = useState<Market[]>([]);
  /** Top-of-book by market id — kept separate so quote WS does not remap the full markets list. */
  const [quotesById, setQuotesById] = useState<Record<string, TopQuote>>({});
  const [marketId, setMarketId] = useState<string>(() => {
    const path = window.location.pathname.replace(/^\/+|\/+$/g, "");
    if (path === "docs" || path === "docs.html" || path.startsWith("docs/")) {
      window.location.replace("https://docs.arizal.xyz/");
      return "";
    }
    return marketIdFromPath(window.location.pathname);
  });
  const [book, setBook] = useState<Book | null>(null);
  const [acct, setAcct] = useState<Account | null>(null);
  const [trades, setTrades] = useState<Fill[]>([]);
  const [fillTx, setFillTx] = useState<Record<number, string>>({});
  const [chart, setChart] = useState<MarketChart | null>(null);
  /** Resolved markets for the current kind/strike (WS `resolved` channel). */
  const [resolvedStrike, setResolvedStrike] = useState<Market[]>([]);
  const [savedUi] = useState(readUiPrefs);
  const [settledLocal, setSettledLocal] = useState<Set<string>>(() => new Set());
  const [mineTab, setMineTab] = useState(savedUi.mineTab);
  const [positions, setPositions] = useState<MinePos[]>([]);
  const [myFills, setMyFills] = useState<MyFill[]>([]);
  const [dbOrders, setDbOrders] = useState<LedgerOrder[]>([]);
  const [funds, setFunds] = useState<LedgerFund[]>([]);
  const [lastYes, setLastYes] = useState<Record<string, number>>({});
  /** Yes book mid (¢) by market id — for position mark value. */
  const [posMids, setPosMids] = useState<Record<string, number>>({});
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));
  const [spotRaw, setSpotRaw] = useState<string | null>(null);
  /** Exclusive overlay: markets | fees | expiry | account (see `src/state/machines.ts`). */
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [placePhase, setPlacePhase] = useState<PlacePhase>("idle");
  const placePhaseRef = useRef<PlacePhase>("idle");
  const [chartTf, setChartTf] = useState(savedUi.chartTf);
  const [marketsTab, setMarketsTab] = useState(savedUi.marketsTab);
  const [marketsTf, setMarketsTf] = useState(savedUi.marketsTf);
  const [side, setSide] = useState(savedUi.side);
  const [intent, setIntent] = useState(savedUi.intent);
  const [entryKind, setEntryKind] = useState(savedUi.entryKind);
  const [price, setPrice] = useState(savedUi.price);
  const [size, setSize] = useState(savedUi.size);
  const [postOnly, setPostOnly] = useState(false);
  const [expiryChoice, setExpiryChoice] = useState<ExpiryChoice>(savedUi.expiryChoice);
  const [savedExpiry, setSavedExpiry] = useState<CustomExpiry | null>(savedUi.savedExpiry);
  const [appliedCustomExpiry, setAppliedCustomExpiry] = useState<CustomExpiry | null>(null);
  const [customDraft, setCustomDraft] = useState<CustomExpiry>(() => savedUi.savedExpiry ?? defaultCustomExpiry());
  const [customDraftSave, setCustomDraftSave] = useState(!!savedUi.savedExpiry);
  const [dwAmt, setDwAmt] = useState("100");
  /** Phone bottom-nav panel: Trade / Chart / Book / Account. */
  const [mobileTab, setMobileTab] = useState<"trade" | "chart" | "book" | "account">("trade");
  const [walletMenuOpen, setWalletMenuOpen] = useState(false);
  const walletMenuRef = useRef<HTMLDivElement>(null);
  const [apiDown, setApiDown] = useState(false);
  const [wsDown, setWsDown] = useState(false);
  const [nickDraft, setNickDraft] = useState("");
  const [emailDraft, setEmailDraft] = useState("");
  const [emailCodeDraft, setEmailCodeDraft] = useState("");
  const [emailVerifyPending, setEmailVerifyPending] = useState(false);
  const [emailResendAfter, setEmailResendAfter] = useState(0);
  const [accountBusy, setAccountBusy] = useState(false);
  const [referrals, setReferrals] = useState<ReferralsReport | null>(null);
  const [referralsLoading, setReferralsLoading] = useState(false);
  const feeTiersDialogRef = useRef<HTMLDialogElement>(null);
  const customExpiryDialogRef = useRef<HTMLDialogElement>(null);
  const accountDialogRef = useRef<HTMLDialogElement>(null);
  const referDialogRef = useRef<HTMLDialogElement>(null);
  /** Only close modal when pointer-down started on the backdrop (not after text-select drag). */
  const dialogBackdropDownRef = useRef(false);
  const onDialogBackdropPointerDown = (e: ReactPointerEvent<HTMLDialogElement>) => {
    dialogBackdropDownRef.current = e.target === e.currentTarget;
  };
  const onDialogBackdropClick = (e: ReactMouseEvent<HTMLDialogElement>) => {
    if (dialogBackdropDownRef.current && e.target === e.currentTarget) setOverlay(null);
    dialogBackdropDownRef.current = false;
  };
  const marketsOpen = overlay === "markets";
  const feeTiersOpen = overlay === "fees";
  const customExpiryOpen = overlay === "expiry";
  const accountOpen = overlay === "account";
  const referOpen = overlay === "refer";
  const connHealth = connHealthFromFlags(apiDown, wsDown);
  const tradingSession = tradingSessionOf(walletOn, tradingEnabled);
  const didInitFollow = useRef(false);
  /** Market id chosen as the empty-path default (may be refined once spot arrives). */
  const provisionalDefaultId = useRef<string | null>(null);

  useEffect(() => {
    const prefs: UiPrefs = {
      mineTab,
      chartTf,
      marketsTab,
      marketsTf,
      side,
      intent,
      entryKind,
      price,
      size,
      expiryChoice: expiryChoice === "custom" ? "never" : expiryChoice,
      savedExpiry,
    };
    try {
      localStorage.setItem(UI_PREFS_KEY, JSON.stringify(prefs));
    } catch {
      /* private mode */
    }
  }, [mineTab, chartTf, marketsTab, marketsTf, side, intent, entryKind, price, size, expiryChoice, savedExpiry]);
  const midRef = useRef("");
  const marketIdRef = useRef(marketId);
  const traderRef = useRef(trader);
  const acctFundTxRef = useRef(new Set<string>());
  const wsRef = useRef<WebSocket | null>(null);
  const spotRawPendingRef = useRef<string | null>(null);
  const spotRawFlushAtRef = useRef(0);
  const spotRawTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const marketsRef = useRef<Market[]>([]);
  marketsRef.current = markets;
  const spotRawRef = useRef(spotRaw);
  spotRawRef.current = spotRaw;
  const market =
    markets.find((m) => m.id === marketId) ||
    pickDefaultMarket(markets, pxToUsd(spotRaw)) ||
    markets.find((m) => m.status === "Open") ||
    markets[0];
  const mid = market?.id || marketId;
  midRef.current = mid;
  marketIdRef.current = marketId;
  if (traderRef.current !== trader) {
    traderRef.current = trader;
    acctFundTxRef.current = new Set();
  }
  const priceDp = priceDpFor(cfg, marketAsset(market));
  const depth = useMemo(() => sideBook(book, side), [book, side]);
  const mineLevels = useMemo(() => userBookLevels(dbOrders, mid, side), [dbOrders, mid, side]);
  const gridMine = useMemo(() => buildGridMine(positions, dbOrders), [positions, dbOrders]);
  // Account `volume_30d` / `taker_coeff` from the node (hourly UTC :00 + boot + account pushes).
  const volume30d = useMemo(() => {
    const raw = acct?.volume_30d;
    if (raw == null || !Number.isFinite(Number(raw))) return 0;
    return Number(raw) / 1e6;
  }, [acct?.volume_30d]);
  const feeProgress = useMemo(() => feeTierProgress(volume30d), [volume30d]);
  const feeTier = feeProgress.current;
  /** Wallet taker fee coefficient from GET /account + account WS (not local tier table). */
  const walletTakerCoeff = useMemo(() => {
    const c = acct?.taker_coeff;
    if (c == null || !Number.isFinite(Number(c)) || Number(c) <= 0) return null;
    return Number(c);
  }, [acct?.taker_coeff]);
  const bookSeqRef = useRef(-1);

  // Modal <dialog> uses the browser top layer; keep Toastify there (and re-stack after each modal open).
  useEffect(() => {
    const root = document.querySelector(".Toastify") as HTMLElement | null;
    if (!root || typeof root.showPopover !== "function") return;
    root.setAttribute("popover", "manual");
    try {
      if (root.matches(":popover-open")) root.hidePopover();
      root.showPopover();
    } catch {
      /* unsupported / already transitioning */
    }
  }, [accountOpen, feeTiersOpen, customExpiryOpen, referOpen]);

  useEffect(() => {
    const el = feeTiersDialogRef.current;
    if (!el) return;
    if (feeTiersOpen) {
      if (!el.open) el.showModal();
    } else if (el.open) {
      el.close();
    }
  }, [feeTiersOpen]);

  useEffect(() => {
    const el = customExpiryDialogRef.current;
    if (!el) return;
    if (customExpiryOpen) {
      if (!el.open) el.showModal();
    } else if (el.open) {
      el.close();
    }
  }, [customExpiryOpen]);

  useEffect(() => {
    const el = accountDialogRef.current;
    if (!el) return;
    if (accountOpen) {
      if (!el.open) el.showModal();
    } else if (el.open) {
      el.close();
    }
  }, [accountOpen]);

  useEffect(() => {
    const el = referDialogRef.current;
    if (!el) return;
    if (referOpen) {
      if (!el.open) el.showModal();
    } else if (el.open) {
      el.close();
    }
  }, [referOpen]);

  // Persist `?r=` / `?ref=` / `?referrer=` for visitors before they connect.
  useEffect(() => {
    captureReferrerFromUrl();
  }, []);

  function openAccountDialog() {
    setNickDraft(acct?.nickname?.trim() || "");
    setEmailDraft(acct?.email?.trim() || "");
    setEmailCodeDraft("");
    setEmailVerifyPending(false);
    setEmailResendAfter(0);
    setOverlay("account");
  }

  function openReferDialog() {
    setOverlay("refer");
    if (!trader) {
      setReferrals(null);
      return;
    }
    setReferralsLoading(true);
    api
      .referrals(trader)
      .then((r) => setReferrals(r))
      .catch(() => setReferrals(null))
      .finally(() => setReferralsLoading(false));
  }

  function openCustomExpiryDialog() {
    const base =
      (expiryChoice === "saved" && savedExpiry) ||
      (expiryChoice === "custom" && appliedCustomExpiry) ||
      savedExpiry ||
      appliedCustomExpiry ||
      defaultCustomExpiry();
    setCustomDraft(base);
    setCustomDraftSave(!!savedExpiry);
    setOverlay("expiry");
  }

  function applyCustomExpiry() {
    const next = { ...customDraft };
    if (next.mode === "before_market" && next.beforeSecs < 0) {
      toast.error("time before expiry must be ≥ 0");
      return;
    }
    if (next.mode === "absolute") {
      const minAt = Math.floor(Date.now() / 1000) + 60;
      if (next.atUnix < minAt) {
        toast.error("expiry must be at least 60s from now");
        return;
      }
    }
    if (customDraftSave) {
      setSavedExpiry(next);
      setAppliedCustomExpiry(next);
      setExpiryChoice("saved");
    } else {
      setAppliedCustomExpiry(next);
      setExpiryChoice("custom");
    }
    setOverlay(null);
  }

  const patchChartMid = useCallback((midPx: number | null) => {
    if (midPx == null) return;
    const ts = Math.floor(Date.now() / 1000);
    const minute = Math.floor(ts / 60) * 60;
    const price = fmtCents(midPx);
    setChart((prev) => {
      if (!prev) return prev;
      const points = prev.points ? prev.points.slice() : [];
      const last = points[points.length - 1];
      if (last && last.ts === minute) points[points.length - 1] = { ts: minute, price };
      else if (minute >= (prev.start_ts || 0)) points.push({ ts: minute, price });
      return {
        ...prev,
        now_ts: ts,
        end_ts: Math.max(prev.end_ts || ts, ts),
        current: price,
        points,
      };
    });
  }, []);

  const applyBook = useCallback(
    (b: Book | null | undefined) => {
      if (!b) return;
      const seq = typeof b.seq === "number" ? b.seq : 0;
      if (seq <= bookSeqRef.current) return;
      bookSeqRef.current = seq;
      setBook(b);
      patchChartMid(yesMidCents(b));
    },
    [patchChartMid]
  );

  const openMarket = useCallback((id: string, mode: "push" | "replace" = "push", nextSide?: Side) => {
    setMarketId(id);
    if (nextSide) setSide(nextSide);
    const url = `/${id}`;
    if (window.location.pathname === url) return;
    if (mode === "replace") {
      window.history.replaceState({ marketId: id }, "", url);
    } else {
      window.history.pushState({ marketId: id }, "", url);
    }
  }, []);

  const applyDefaultMarket = useCallback(
    (ms: Market[], spot: number | null) => {
      if (marketIdFromPath(window.location.pathname)) return;
      const preferred =
        pickDefaultMarket(ms, spot) || ms.find((x) => x.status === "Open") || ms[0];
      if (!preferred) return;
      const cur = marketIdRef.current;
      if (cur && cur !== provisionalDefaultId.current) return;
      if (preferred.id === cur) {
        provisionalDefaultId.current = preferred.id;
        return;
      }
      provisionalDefaultId.current = preferred.id;
      setMarketsTab("hit");
      setMarketsTf("daily");
      setSide("Yes");
      openMarket(preferred.id, "replace");
    },
    [openMarket]
  );

  const applyMarkets = useCallback(
    (ms: Market[]) => {
      if (ms.length === 0) return;
      setMarkets(ms);
      setQuotesById(quotesFromMarkets(ms));
      const fromUrl = marketIdFromPath(window.location.pathname);
      if (!didInitFollow.current) didInitFollow.current = true;
      if (fromUrl) {
        if (fromUrl !== marketIdRef.current) {
          if (ms.some((x) => x.id === fromUrl)) openMarket(fromUrl, "replace");
          else setMarketId(fromUrl);
        }
        return;
      }
      applyDefaultMarket(ms, pxToUsd(spotRawRef.current));
    },
    [openMarket, applyDefaultMarket]
  );

  /** Upsert one market from WS `{ channel: market, op: "opened" }` (full list is not resent on open). */
  const upsertMarket = useCallback((m: Market) => {
    setMarkets((prev) => {
      const i = prev.findIndex((x) => x.id === m.id);
      if (i < 0) return [m, ...prev];
      const next = prev.slice();
      next[i] = m;
      return next;
    });
    setQuotesById((prev) => ({
      ...prev,
      [m.id]: {
        bid: typeof m.best_yes_bid === "number" ? m.best_yes_bid : null,
        ask: typeof m.best_yes_ask === "number" ? m.best_yes_ask : null,
      },
    }));
  }, []);

  const mapLedgerTrades = useCallback((ledgerTrades: LedgerTrade[], ms: Market[]): MyFill[] => {
    const hexRe = /^0x[0-9a-fA-F]{64}$/;
    const hashToSlug = new Map<string, string>();
    for (const m of ms) hashToSlug.set(marketIdHash(m.id).toLowerCase(), m.id);
    for (const t of ledgerTrades) {
      if (!hexRe.test(t.market_id)) hashToSlug.set(marketIdHash(t.market_id).toLowerCase(), t.market_id);
    }
    const resolveMid = (id: string) => (hexRe.test(id) ? hashToSlug.get(id.toLowerCase()) || id : id);
    const statusRank = (s: string) => (s === "confirmed" ? 0 : s === "pending" ? 1 : 2);
    const orderedTrades = [...ledgerTrades].sort((a, b) => {
      const sr = statusRank(a.status || "confirmed") - statusRank(b.status || "confirmed");
      if (sr !== 0) return sr;
      return Number(hexRe.test(a.market_id)) - Number(hexRe.test(b.market_id));
    });
    const seenTx = new Set<string>();
    const seenSize = new Set<string>();
    const fills: MyFill[] = [];
    for (const t of orderedTrades) {
      const id = resolveMid(t.market_id);
      const op = t.op || "trade";
      const tx = (t.tx_hash || "").toLowerCase();
      const sizeKey = `${id}:${t.side}:${t.size}:${t.price}:${op}`;
      if (tx.startsWith("0x")) {
        const txKey = `${id}:${t.side}:${tx}:${op}`;
        if (seenTx.has(txKey) || seenSize.has(sizeKey)) continue;
        seenTx.add(txKey);
        seenSize.add(sizeKey);
      } else {
        if (seenSize.has(sizeKey)) continue;
        seenSize.add(sizeKey);
      }
      fills.push({
        id: t.id,
        marketId: id,
        side: t.side,
        price: t.price,
        yesPrice: t.yes_price,
        shares: Number(t.size),
        ts: t.ts,
        closing: t.closing,
        isTaker: t.is_taker,
        pnl: t.pnl,
        fee: t.fee,
        op,
        status: t.status || "confirmed",
        txHash: t.tx_hash,
        logIndex: t.log_index,
        block: t.block,
      });
    }
    fills.sort((a, b) => b.ts - a.ts || (b.id ?? 0) - (a.id ?? 0));
    return fills;
  }, []);

  const resolveLedgerMarketId = useCallback((id: string, extra?: { market_id: string }[]) => {
    const ms = marketsRef.current;
    const hexRe = /^0x[0-9a-fA-F]{64}$/;
    if (!hexRe.test(id)) return id;
    const hashToSlug = new Map<string, string>();
    for (const m of ms) hashToSlug.set(marketIdHash(m.id).toLowerCase(), m.id);
    for (const p of extra || []) {
      if (!hexRe.test(p.market_id)) hashToSlug.set(marketIdHash(p.market_id).toLowerCase(), p.market_id);
    }
    return hashToSlug.get(id.toLowerCase()) || id;
  }, []);

  const applyLedgerSnapshot = useCallback(
    (poss: LedgerPos[], ledgerTrades: LedgerTrade[]) => {
      const ms = marketsRef.current;
      // Drop duplicate rows keyed by bytes32 hex when the slug row already exists.
      const hexRe = /^0x[0-9a-fA-F]{64}$/;
      const hashToSlug = new Map<string, string>();
      for (const m of ms) hashToSlug.set(marketIdHash(m.id).toLowerCase(), m.id);
      for (const p of poss) {
        if (!hexRe.test(p.market_id)) hashToSlug.set(marketIdHash(p.market_id).toLowerCase(), p.market_id);
      }
      for (const t of ledgerTrades) {
        if (!hexRe.test(t.market_id)) hashToSlug.set(marketIdHash(t.market_id).toLowerCase(), t.market_id);
      }
      const resolveMid = (id: string) => (hexRe.test(id) ? hashToSlug.get(id.toLowerCase()) || id : id);

      const seenPos = new Set<string>();
      const rows: MinePos[] = [];
      const orderedPos = [...poss].sort((a, b) => Number(hexRe.test(a.market_id)) - Number(hexRe.test(b.market_id)));
      for (const p of orderedPos) {
        const id = resolveMid(p.market_id);
        const key = `${id}:${p.side}`;
        if (seenPos.has(key)) continue;
        seenPos.add(key);
        const mkt = ms.find((x) => x.id === id);
        rows.push({
          marketId: id,
          barrier: mkt?.barrier || "0",
          side: p.side,
          shares: p.shares,
          usdc: p.usdc_staked,
          redeemed: !!p.redeemed,
        });
      }
      rows.sort((a, b) => {
        const d = barrierKey({ barrier: b.barrier } as Market) - barrierKey({ barrier: a.barrier } as Market);
        if (d > 0n) return 1;
        if (d < 0n) return -1;
        return a.marketId < b.marketId ? -1 : a.marketId > b.marketId ? 1 : a.side === b.side ? 0 : a.side === "Yes" ? -1 : 1;
      });

      setMyFills(mapLedgerTrades(ledgerTrades, ms));
      setPositions(rows);
    },
    [mapLedgerTrades]
  );

  /** Match-time patch: merge new trades + upsert/remove positions without replacing history. */
  const applyLedgerDelta = useCallback(
    (
      ledgerTrades: LedgerTrade[],
      poss: LedgerPos[],
      removes: { market_id: string; side: string }[]
    ) => {
      const ms = marketsRef.current;
      if (ledgerTrades.length) {
        const incoming = mapLedgerTrades(ledgerTrades, ms);
        setMyFills((prev) => {
          const rank = (s?: string) => (s === "confirmed" ? 0 : s === "pending" ? 1 : 2);
          const keyOf = (r: MyFill) => `${r.id}:${r.marketId}:${r.side}:${r.op || "trade"}`;
          const byKey = new Map<string, MyFill>();
          for (const r of prev) byKey.set(keyOf(r), r);
          for (const n of incoming) {
            const k = keyOf(n);
            const old = byKey.get(k);
            if (!old) {
              byKey.set(k, n);
              continue;
            }
            // Never let a stale pending delta demote a receipt-confirmed History row.
            if (rank(n.status) < rank(old.status)) {
              byKey.set(k, { ...old, ...n });
            } else if (rank(n.status) === rank(old.status)) {
              byKey.set(k, {
                ...old,
                ...n,
                txHash: (n.txHash || "").startsWith("0x") ? n.txHash : old.txHash,
              });
            } else if ((n.txHash || "").startsWith("0x") && !(old.txHash || "").startsWith("0x")) {
              byKey.set(k, { ...old, txHash: n.txHash });
            }
          }
          const merged = [...byKey.values()];
          merged.sort((a, b) => b.ts - a.ts || (b.id ?? 0) - (a.id ?? 0));
          return merged.slice(0, 500);
        });
      }
      if (poss.length || removes.length) {
        setPositions((prev) => {
          const byKey = new Map(prev.map((p) => [`${p.marketId}:${p.side}`, p]));
          for (const r of removes) {
            const id = resolveLedgerMarketId(r.market_id, removes);
            byKey.delete(`${id}:${r.side}`);
          }
          for (const p of poss) {
            const id = resolveLedgerMarketId(p.market_id, poss);
            const mkt = ms.find((x) => x.id === id);
            byKey.set(`${id}:${p.side}`, {
              marketId: id,
              barrier: mkt?.barrier || byKey.get(`${id}:${p.side}`)?.barrier || "0",
              side: p.side,
              shares: p.shares,
              usdc: p.usdc_staked,
              redeemed: !!p.redeemed,
            });
          }
          const rows = [...byKey.values()];
          rows.sort((a, b) => {
            const d = barrierKey({ barrier: b.barrier } as Market) - barrierKey({ barrier: a.barrier } as Market);
            if (d > 0n) return 1;
            if (d < 0n) return -1;
            return a.marketId < b.marketId ? -1 : a.marketId > b.marketId ? 1 : a.side === b.side ? 0 : a.side === "Yes" ? -1 : 1;
          });
          return rows;
        });
      }
    },
    [mapLedgerTrades, resolveLedgerMarketId]
  );

  /** Wallet ledger only. Account is fetched separately and sparsely — it hits chain RPC. */
  const refresh = useCallback(async () => {
    try {
      setApiDown(false);
      if (!trader) {
        setDbOrders([]);
        setPositions([]);
        setMyFills([]);
        setFunds([]);
        return;
      }
      const [orders, ledgerTrades, poss, cash] = await Promise.all([
        api.ledgerOrders(trader).catch(() => []),
        api.ledgerHistory(trader).catch(() => []),
        api.ledgerPositions(trader).catch(() => []),
        api.ledgerFunds(trader).catch(() => []),
      ]);
      setFunds(cash);
      setDbOrders(orders);
      applyLedgerSnapshot(poss, ledgerTrades);
    } catch (e: unknown) {
      const msg = String(e);
      if (e instanceof TypeError || /failed to fetch|networkerror|load failed/i.test(msg)) {
        setApiDown(true);
      } else {
        toast.error(msg);
      }
    }
  }, [trader, applyLedgerSnapshot]);

  // Config once.
  useEffect(() => {
    let stop = false;
    (async () => {
      try {
        const [c, px] = await Promise.all([api.config(), api.price().catch(() => null)]);
        if (!stop) {
          setCfg(c);
          if (px?.price) setSpotRaw(String(px.price));
          setApiDown(false);
        }
      } catch {
        if (!stop) setApiDown(true);
      }
    })();
    return () => {
      stop = true;
    };
  }, []);

  // Refine empty-path default once spot is known (closest daily hit-up barrier).
  useEffect(() => {
    if (!spotRaw || markets.length === 0) return;
    applyDefaultMarket(markets, pxToUsd(spotRaw));
  }, [spotRaw, markets, applyDefaultMarket]);

  useEffect(() => {
    const lasts: Record<string, number> = {};
    for (const m of markets) {
      const px = m.last_yes_price;
      if (typeof px !== "number" || !(px > 0) || px >= 100) continue;
      lasts[m.id] = px;
    }
    if (mid && trades[0] && typeof trades[0].yes_price === "number") {
      lasts[mid] = trades[0].yes_price;
    }
    setLastYes(lasts);
  }, [markets, mid, trades]);

  // Coarse clock for pill colors / hour-minute expiry labels (not second countdowns).
  useEffect(() => {
    const id = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 30_000);
    return () => clearInterval(id);
  }, []);

  const bookRef = useRef(book);
  bookRef.current = book;

  // Yes mid for each open position market (mark-to-market).
  const posMarketIds = useMemo(
    () =>
      [...new Set(positions.filter((p) => Number(p.shares) > 0).map((p) => p.marketId))].sort().join(","),
    [positions]
  );
  useEffect(() => {
    let stop = false;
    const ids = posMarketIds ? posMarketIds.split(",") : [];
    const load = async () => {
      if (ids.length === 0) {
        if (!stop) setPosMids({});
        return;
      }
      const next: Record<string, number> = {};
      await Promise.all(
        ids.map(async (id) => {
          try {
            if (id === midRef.current) {
              const live = yesMidCents(bookRef.current);
              if (live != null) {
                next[id] = live;
                return;
              }
            }
            const m = yesMidCents(await api.book(id));
            if (m != null) next[id] = m;
          } catch {
            /* ignore */
          }
        })
      );
      if (!stop) setPosMids(next);
    };
    load();
    const t = setInterval(load, 15_000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [posMarketIds]);

  // Keep the selected market's mark mid in sync with the live book without refetching.
  useEffect(() => {
    if (!mid) return;
    const live = yesMidCents(book);
    if (live == null) return;
    setPosMids((prev) => (prev[mid] === live ? prev : { ...prev, [mid]: live }));
  }, [book, mid]);

  // Wallet ledger when trader changes; not on a timer.
  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    const onPop = () => setMarketId(marketIdFromPath(window.location.pathname));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    if (!walletMenuOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      const el = walletMenuRef.current;
      if (el && e.target instanceof Node && !el.contains(e.target)) setWalletMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setWalletMenuOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [walletMenuOpen]);

  useEffect(() => {
    setWalletMenuOpen(false);
  }, [trader, isConnected]);

  // Chart mid history once per market/tf; current minute tip from book WS.
  useEffect(() => {
    if (!mid) return;
    let stop = false;
    const load = () =>
      api
        .chart(mid, chartTf)
        .then((c) => {
          if (!stop) setChart(c);
        })
        .catch(() => {
          if (!stop) setChart(null);
        });
    load();
    const id = setInterval(load, 30_000);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, [mid, chartTf]);

  // Account once per market/trader — never in a markets/WS loop.
  useEffect(() => {
    if (!mid) return;
    let stop = false;
    if (trader) {
      api.account(trader, mid)
        .then((a) => {
          if (!stop) setAcct(a);
        })
        .catch(() => {});
    } else {
      setAcct(null);
    }
    return () => {
      stop = true;
    };
  }, [mid, trader]);

  // On wallet connect: attribute pending `?r=` referrer once (server keeps existing).
  useEffect(() => {
    if (!trader) return;
    const ref = captureReferrerFromUrl();
    if (!ref) return;
    if (ref === trader.toLowerCase()) {
      clearStoredReferrer();
      return;
    }
    let stop = false;
    api
      .setReferrer({ trader, referrer: ref })
      .then((r) => {
        if (stop) return;
        clearStoredReferrer();
        setAcct((a) => (a ? { ...a, referrer: r.referrer } : a));
      })
      .catch(() => {
        /* keep stored ref for a later retry */
      });
    return () => {
      stop = true;
    };
  }, [trader]);

  useEffect(() => {
    refreshTradingEnabled();
    // refreshTradingEnabled closes over latest cfg/trader
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publicClient, cfg?.exchange, trader]);

  useEffect(() => {
    let stop = false;
    let sock: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    const subMarket = (s: WebSocket, id: string) => {
      s.send(JSON.stringify({ op: "subscribe", channel: "book", market: id }));
      s.send(JSON.stringify({ op: "subscribe", channel: "tape", market: id }));
      s.send(JSON.stringify({ op: "subscribe", channel: "trades", market: id }));
      s.send(JSON.stringify({ op: "subscribe", channel: "resolved", market: id }));
    };
    const sub = (s: WebSocket) => {
      if (s.readyState !== WebSocket.OPEN) return;
      s.send(JSON.stringify({ op: "subscribe", channel: "markets" }));
      s.send(JSON.stringify({ op: "subscribe", channel: "price" }));
      const id = midRef.current;
      if (id) subMarket(s, id);
    };
    const connect = () => {
      if (stop) return;
      let ws: WebSocket;
      try {
        ws = new WebSocket(wsUrl());
      } catch {
        setWsDown(true);
        setApiDown(true);
        timer = setTimeout(connect, 1000);
        return;
      }
      sock = ws;
      wsRef.current = ws;
      ws.onopen = () => {
        attempt = 0;
        setWsDown(false);
        setApiDown(false);
        sub(ws);
      };
      ws.onerror = () => setWsDown(true);
      ws.onclose = () => {
        if (wsRef.current === ws) wsRef.current = null;
        if (stop) return;
        setWsDown(true);
        setApiDown(true);
        const wait = Math.min(5000, 400 * 2 ** attempt);
        attempt += 1;
        timer = setTimeout(connect, wait);
      };
      ws.onmessage = (ev) => {
        let v: {
          channel?: string;
          /** Market id (most channels) or full market row (`channel: market`, `op: opened`). */
          market?: string | Market;
          strike?: string;
          seq?: number;
          bids_yes?: Book["bids_yes"];
          bids_no?: Book["bids_no"];
          event?: TapeEvent;
          events?: TapeEvent[];
          fill?: Fill;
          fills?: Fill[];
          markets?: Market[];
          best_yes_bid?: number | null;
          best_yes_ask?: number | null;
          price?: string | number;
          spot?: string;
          barrier?: string;
          ts?: number;
          source?: string;
          trader?: string;
          op?: string;
          amount?: number | string;
          /** Absolute exchange balance (redeem / split / merge / fill / close). */
          collateral?: number | string;
          /** 30d weighted volume micro-USD (hourly snapshot). */
          volume_30d?: number | string;
          /** Taker fee coefficient for this wallet's volume tier. */
          taker_coeff?: number | string;
          /** Live taker gas fee (USDC raw) on `channel: config`. */
          gas_fee?: number | string;
          trading_fee_factor?: string;
          tx_hash?: string;
          positions?: LedgerPos[];
          trades?: LedgerTrade[];
          orders?: LedgerOrder[];
        };
        try {
          v = JSON.parse(ev.data);
        } catch {
          return;
        }
        const id = midRef.current;
        const msgMarketId =
          typeof v.market === "string" ? v.market : v.market && typeof v.market === "object" ? v.market.id : undefined;
        if (v.channel === "markets" && Array.isArray(v.markets)) {
          applyMarkets(v.markets);
          return;
        }
        if (v.channel === "market" && v.op === "opened" && v.market && typeof v.market === "object") {
          upsertMarket(v.market);
          return;
        }
        if (v.channel === "resolved" && Array.isArray(v.markets)) {
          const cur = marketsRef.current.find((m) => m.id === id);
          const want = marketResolvedKey(cur);
          if (
            msgMarketId === id ||
            (want && v.strike === want) ||
            (want && v.markets.some((m) => marketResolvedKey(m) === want))
          ) {
            setResolvedStrike(v.markets);
          }
          return;
        }
        if (
          v.channel === "quote" &&
          msgMarketId &&
          (v.best_yes_bid !== undefined || v.best_yes_ask !== undefined)
        ) {
          const bid =
            typeof v.best_yes_bid === "number"
              ? v.best_yes_bid
              : v.best_yes_bid == null
                ? null
                : Number(v.best_yes_bid);
          const ask =
            typeof v.best_yes_ask === "number"
              ? v.best_yes_ask
              : v.best_yes_ask == null
                ? null
                : Number(v.best_yes_ask);
          const nextBid = Number.isFinite(bid as number) ? (bid as number) : null;
          const nextAsk = Number.isFinite(ask as number) ? (ask as number) : null;
          setQuotesById((prev) => {
            const cur = prev[msgMarketId];
            if (cur && cur.bid === nextBid && cur.ask === nextAsk) return prev;
            return { ...prev, [msgMarketId]: { bid: nextBid, ask: nextAsk } };
          });
          return;
        }
        if (v.channel === "price") {
          const raw = v.spot || (typeof v.price === "string" || typeof v.price === "number" ? String(v.price) : null);
          if (!raw) return;
          // Binance ticks are ~10–20Hz; throttle UI spot so the whole tree does not re-render each tick.
          const now = performance.now();
          spotRawPendingRef.current = raw;
          if (now - spotRawFlushAtRef.current < 250) {
            if (spotRawTimerRef.current == null) {
              spotRawTimerRef.current = setTimeout(() => {
                spotRawTimerRef.current = null;
                spotRawFlushAtRef.current = performance.now();
                const pending = spotRawPendingRef.current;
                if (pending) setSpotRaw(pending);
              }, 250);
            }
            return;
          }
          spotRawFlushAtRef.current = now;
          setSpotRaw(raw);
          return;
        }
        if (v.channel === "config") {
          const gas = typeof v.gas_fee === "number" ? v.gas_fee : Number(v.gas_fee);
          setCfg((c) =>
            c
              ? {
                  ...c,
                  gas_fee: Number.isFinite(gas) ? gas : c.gas_fee,
                  trading_fee_factor:
                    typeof v.trading_fee_factor === "string" ? v.trading_fee_factor : c.trading_fee_factor,
                }
              : c
          );
          return;
        }
        if (v.channel === "last_yes" && msgMarketId && v.price != null) {
          const px = typeof v.price === "number" ? v.price : Number(v.price);
          if (!(px > 0) || px >= 100) return;
          setLastYes((m) => (m[msgMarketId] === px ? m : { ...m, [msgMarketId]: px }));
          return;
        }
        if (v.channel === "tape_snapshot" && msgMarketId === id && Array.isArray(v.events)) {
          const tape = v.events;
          const tx: Record<number, string> = {};
          for (const e of tape) {
            if (e.kind === "FillCommitted" && e.fill_id != null && e.tx_hash) tx[e.fill_id] = e.tx_hash;
          }
          setFillTx(tx);
          return;
        }
        if (v.channel === "trades_snapshot" && msgMarketId === id && Array.isArray(v.fills)) {
          setTrades(v.fills);
          return;
        }
        if (v.channel === "book" && msgMarketId === id) {
          applyBook({
            market_id: msgMarketId,
            bids_yes: v.bids_yes || [],
            bids_no: v.bids_no || [],
            seq: v.seq ?? 0,
          });
        } else if (v.channel === "tape" && v.event) {
          const e = v.event;
          // History is cross-market — confirm before the selected-market tape filter.
          if (e.kind === "FillCommitted" && e.fill_id != null && e.tx_hash) {
            const fid = e.fill_id;
            const hash = e.tx_hash;
            setFillTx((m) => (m[fid] === hash ? m : { ...m, [fid]: hash }));
            setMyFills((rows) =>
              rows.map((r) =>
                r.status === "pending" && Number(r.id) === Number(fid)
                  ? { ...r, status: "confirmed", txHash: hash }
                  : r
              )
            );
          }
          const em = tapeMarketId(e);
          if (em && em !== id) return;
        } else if (v.channel === "trades" && v.fill) {
          const f = v.fill;
          // History is cross-market — promote pending legs even when viewing another market.
          if (f.confirmed && (f.tx_hash || "").startsWith("0x")) {
            setMyFills((rows) =>
              rows.map((r) =>
                r.status === "pending" &&
                (Number(r.id) === Number(f.fill_id) ||
                  (r.marketId === f.market_id &&
                    Math.abs((r.ts || 0) - f.ts_engine) <= 2 &&
                    Math.abs(Number(r.shares) - Number(f.size)) < 1e-9))
                  ? { ...r, status: "confirmed", txHash: f.tx_hash }
                  : r
              )
            );
          }
          if (f.market_id && f.market_id !== id) return;
          setTrades((t) => {
            const i = t.findIndex((x) => x.fill_id === f.fill_id);
            if (i >= 0) {
              const next = t.slice();
              next[i] = f;
              return next;
            }
            return [f, ...t].slice(0, 200);
          });
        } else if (v.channel === "ledger" && v.trader && Array.isArray(v.positions) && Array.isArray(v.trades)) {
          const me = traderRef.current?.toLowerCase();
          if (!me || String(v.trader).toLowerCase() !== me) return;
          applyLedgerSnapshot(v.positions, v.trades);
        } else if (v.channel === "ledger_delta" && v.trader) {
          const me = traderRef.current?.toLowerCase();
          if (!me || String(v.trader).toLowerCase() !== me) return;
          const trades = Array.isArray(v.trades) ? (v.trades as LedgerTrade[]) : [];
          const positions = Array.isArray(v.positions) ? (v.positions as LedgerPos[]) : [];
          const removes = Array.isArray((v as { remove_positions?: unknown }).remove_positions)
            ? ((v as { remove_positions: { market_id: string; side: string }[] }).remove_positions)
            : [];
          applyLedgerDelta(trades, positions, removes);
        } else if (v.channel === "orders" && v.trader && Array.isArray(v.orders)) {
          const me = traderRef.current?.toLowerCase();
          if (!me || String(v.trader).toLowerCase() !== me) return;
          setDbOrders(v.orders);
        } else if (v.channel === "account" && v.trader) {
          const me = traderRef.current?.toLowerCase();
          if (!me || String(v.trader).toLowerCase() !== me) return;
          const volRaw =
            v.volume_30d != null && Number.isFinite(Number(v.volume_30d)) ? Number(v.volume_30d) : undefined;
          const coeffRaw =
            v.taker_coeff != null && Number.isFinite(Number(v.taker_coeff)) && Number(v.taker_coeff) > 0
              ? Number(v.taker_coeff)
              : undefined;
          const volPatch = {
            ...(volRaw != null ? { volume_30d: volRaw } : null),
            ...(coeffRaw != null ? { taker_coeff: coeffRaw } : null),
          };
          // Absolute balance after redeem / split / merge / fill / close (and post-fund refresh).
          if (v.collateral != null) {
            const coll = Number(v.collateral);
            if (!Number.isFinite(coll) || coll < 0) return;
            setAcct((a) => {
              if (!a) return a;
              const reserved = Number(a.reserved) || 0;
              return {
                ...a,
                collateral: coll,
                available: Math.max(0, coll - reserved),
                ...volPatch,
              };
            });
            return;
          }
          if ((volRaw != null || coeffRaw != null) && v.amount == null) {
            setAcct((a) => (a ? { ...a, ...volPatch } : a));
            return;
          }
          if (v.amount == null) return;
          const tx = String(v.tx_hash || "").toLowerCase();
          if (tx) {
            if (acctFundTxRef.current.has(tx)) return;
            acctFundTxRef.current.add(tx);
          }
          const amt = Number(v.amount);
          if (!Number.isFinite(amt) || amt <= 0) return;
          const op = String(v.op || "deposit");
          if (op !== "deposit" && op !== "withdraw") return;
          const delta = op === "withdraw" ? -amt : amt;
          setAcct((a) => {
            if (!a) return a;
            const coll = Math.max(0, Number(a.collateral) + delta);
            const avail = Math.max(0, Number(a.available) + delta);
            return {
              ...a,
              collateral: coll,
              available: avail,
              ...volPatch,
            };
          });
          setFunds((rows) => {
            if (tx && rows.some((r) => (r.tx_hash || "").toLowerCase() === tx && r.status === "confirmed")) {
              return rows.map((r) =>
                (r.tx_hash || "").toLowerCase() === tx ? { ...r, status: "confirmed", amount: amt } : r
              );
            }
            return [
              {
                kind: op,
                amount: amt,
                ts: Number(v.ts) || Math.floor(Date.now() / 1000),
                tx_hash: String(v.tx_hash || ""),
                status: "confirmed",
              },
              ...rows,
            ];
          });
        }
      };
    };
    connect();
    return () => {
      stop = true;
      if (timer) clearTimeout(timer);
      if (spotRawTimerRef.current) {
        clearTimeout(spotRawTimerRef.current);
        spotRawTimerRef.current = null;
      }
      wsRef.current = null;
      sock?.close();
    };
  }, [applyBook, applyMarkets, upsertMarket, applyLedgerSnapshot, applyLedgerDelta]);

  useEffect(() => {
    bookSeqRef.current = -1;
    setTrades([]);
    setFillTx({});
    setResolvedStrike([]);
    const ws = wsRef.current;
    if (!mid || !ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ op: "subscribe", channel: "book", market: mid }));
    ws.send(JSON.stringify({ op: "subscribe", channel: "tape", market: mid }));
    ws.send(JSON.stringify({ op: "subscribe", channel: "trades", market: mid }));
    ws.send(JSON.stringify({ op: "subscribe", channel: "resolved", market: mid }));
  }, [mid]);

  async function ensureHardhat() {
    const want = cfg?.chain_id ?? localChain.id;
    if (walletChainId === want) return;
    await switchChainAsync({ chainId: want });
  }

  async function writeAsUser(opts: {
    address: `0x${string}`;
    abi: readonly unknown[];
    functionName: string;
    args: readonly unknown[];
    nonce?: number;
    chainId?: number;
  }) {
    return writeInjected({
      chainId: localChain.id,
      address: opts.address,
      abi: opts.abi as never,
      functionName: opts.functionName,
      args: opts.args,
      nonce: opts.nonce,
    });
  }

  async function signAsUser(types: Record<string, readonly { name: string; type: string }[]>, primaryType: string, message: Record<string, unknown>) {
    if (!cfg || !trader) throw new Error("wallet/rpc not ready");
    const dom = domain(cfg.chain_id, cfg.exchange);
    const w = await getWalletClient(config, { chainId: localChain.id });
    if (!w) throw new Error(`wallet not on ${localChain.name} (${localChain.id})`);
    return w.signTypedData({ account: trader, domain: dom, types, primaryType, message });
  }

  async function signPersonalAsUser(message: string): Promise<Hex> {
    if (!trader) throw new Error("wallet not ready");
    await ensureHardhat();
    const w = await getWalletClient(config, { chainId: localChain.id });
    if (!w) throw new Error(`wallet not on ${localChain.name} (${localChain.id})`);
    return w.signMessage({ account: trader, message });
  }

  async function saveNickname() {
    if (!cfg || !trader) return;
    const nickname = nickDraft.trim();
    if (nickname.length < 3 || nickname.length > 24) {
      toast.error("Nickname must be 3–24 characters");
      return;
    }
    if (!/^[A-Za-z0-9_]+$/.test(nickname)) {
      toast.error("Nickname: letters, digits, underscore only");
      return;
    }
    setAccountBusy(true);
    try {
      const nonce = Date.now();
      const message = setNicknameMessage(trader as Address, nickname, nonce, cfg.chain_id);
      const signature = await signPersonalAsUser(message);
      const r = await api.setNickname({ trader, nickname, nonce, signature });
      setAcct((a) => (a ? { ...a, nickname: r.nickname } : a));
      toast.success("Nickname saved");
    } catch (e) {
      toast.error(String(e));
    } finally {
      setAccountBusy(false);
    }
  }

  async function saveEmail() {
    if (!cfg || !trader) return;
    const email = emailDraft.trim().toLowerCase();
    if (!email.includes("@") || email.length < 5) {
      toast.error("Enter a valid email");
      return;
    }
    setAccountBusy(true);
    try {
      const nonce = Date.now();
      const message = setEmailMessage(trader as Address, email, nonce, cfg.chain_id);
      const signature = await signPersonalAsUser(message);
      const r = await api.setEmail({ trader, email, nonce, signature });
      setAcct((a) =>
        a ? { ...a, email: r.email, email_verified: false } : a
      );
      setEmailDraft(r.email);
      setEmailCodeDraft("");
      setEmailVerifyPending(true);
      if (r.resend_after) setEmailResendAfter(r.resend_after);
      if (r.email_sent) {
        toast.success("Verification code sent — check your email");
      } else if (r.verification_code) {
        toast.info(`Enter verification code ${r.verification_code}`);
      } else {
        toast.success("Check your email for the verification code");
      }
    } catch (e) {
      toast.error(String(e));
    } finally {
      setAccountBusy(false);
    }
  }

  async function submitEmailCode() {
    if (!trader) return;
    const code = emailCodeDraft.trim();
    if (!/^\d{6}$/.test(code)) {
      toast.error("Enter the 6-digit code");
      return;
    }
    setAccountBusy(true);
    try {
      const r = await api.verifyEmail({ trader, code });
      setAcct((a) =>
        a ? { ...a, email: r.email, email_verified: true } : a
      );
      setEmailVerifyPending(false);
      setEmailCodeDraft("");
      toast.success("Email verified");
    } catch (e) {
      toast.error(String(e));
    } finally {
      setAccountBusy(false);
    }
  }

  async function resendEmailCode() {
    if (!cfg || !trader) return;
    // Must match the pending address on the node (not an unsaved draft).
    const email = (acct?.email || "").trim().toLowerCase();
    if (!email.includes("@") || acct?.email_verified) {
      toast.error("Save an email first");
      return;
    }
    setAccountBusy(true);
    try {
      const nonce = Date.now();
      const message = resendEmailCodeMessage(trader as Address, email, nonce, cfg.chain_id);
      const signature = await signPersonalAsUser(message);
      const r = await api.resendEmailCode({ trader, nonce, signature });
      setEmailDraft(r.email);
      setEmailCodeDraft("");
      setEmailVerifyPending(true);
      setAcct((a) => (a ? { ...a, email: r.email, email_verified: false } : a));
      if (r.resend_after) setEmailResendAfter(r.resend_after);
      if (r.email_sent) {
        toast.success("Verification code resent — check your email");
      } else if (r.verification_code) {
        toast.info(`Enter verification code ${r.verification_code}`);
      } else {
        toast.success("Check your email for the verification code");
      }
    } catch (e) {
      const msg = String(e);
      const m = msg.match(/retry in (\d+)s/i);
      if (m) setEmailResendAfter(Math.floor(Date.now() / 1000) + Number(m[1]));
      toast.error(msg);
    } finally {
      setAccountBusy(false);
    }
  }

  /** EIP-712 typed data: prefer the session key when 1-click trading is active. */
  async function signSessionOrUser(
    types: Record<string, readonly { name: string; type: string }[]>,
    primaryType: string,
    message: Record<string, unknown>,
  ): Promise<Hex> {
    if (!cfg || !trader) throw new Error("wallet/rpc not ready");
    const wallet = loadTradingAccount(trader as Address);
    if (tradingEnabled && wallet) {
      const dom = domain(cfg.chain_id, cfg.exchange);
      return wallet.signTypedData({
        domain: dom,
        types,
        primaryType,
        message: message as never,
      });
    }
    return signAsUser(types, primaryType, message);
  }

  /** EIP-712 Order: prefer the authorized wallet when Enable Trading is active. */
  async function signOrder(message: Record<string, unknown>): Promise<Hex> {
    return signSessionOrUser(orderTypes, "Order", message);
  }

  function sessionAgentAuth():
    | {
        arizal_chain: string;
        agent_address: string;
        nonce: number;
        expires_at: number;
        signature: `0x${string}`;
      }
    | undefined {
    if (!trader || !tradingEnabled || !loadTradingAccount(trader as Address)) return undefined;
    const auth = loadAgentAuth(trader as Address);
    if (!auth) throw new Error("1-click session expired — enable trading again");
    return {
      arizal_chain: auth.arizal_chain,
      agent_address: auth.agent_address,
      nonce: auth.nonce,
      expires_at: auth.expires_at,
      signature: auth.signature,
    };
  }

  function arizalChainLabel(): string {
    if (cfg?.chain_id === 31337) return "Local";
    if (cfg?.chain_id === 421614) return "Testnet";
    return "Mainnet";
  }

  function refreshTradingEnabled() {
    if (!cfg || !trader) {
      setTradingEnabled(false);
      return;
    }
    const wallet = loadTradingAccount(trader as Address);
    const auth = loadAgentAuth(trader as Address);
    setTradingEnabled(
      !!wallet &&
        !!auth &&
        auth.agent_address.toLowerCase() === wallet.address.toLowerCase() &&
        auth.expires_at > Math.floor(Date.now() / 1000),
    );
  }

  async function enableTrading() {
    if (!cfg || !trader) return;
    try {
      await ensureHardhat();
      let wallet = loadTradingAccount(trader as Address);
      if (!wallet) wallet = createTradingAccount(trader as Address);
      const expiresAt = Math.floor(Date.now() / 1000) + 24 * 60 * 60;
      const nonce = Date.now();
      const msg = {
        arizalChain: arizalChainLabel(),
        agentAddress: wallet.address,
        nonce: BigInt(nonce),
        expiresAt: BigInt(expiresAt),
      };
      const signature = await signAsUser(
        {
          ApproveAgent: [
            { name: "arizalChain", type: "string" },
            { name: "agentAddress", type: "address" },
            { name: "nonce", type: "uint64" },
            { name: "expiresAt", type: "uint64" },
          ],
        },
        "ApproveAgent",
        msg,
      );
      saveAgentAuth(trader as Address, {
        arizal_chain: msg.arizalChain,
        agent_address: wallet.address,
        nonce,
        expires_at: expiresAt,
        signature: signature as `0x${string}`,
      });
      setTradingEnabled(true);
      toast.success("1-Click trading enabled");
    } catch (e: unknown) {
      toast.error(explainErr(e));
    }
  }

  function disableTrading() {
    if (!trader) return;
    clearTradingAccount(trader as Address);
    setTradingEnabled(false);
    toast.success("1-Click trading disabled");
  }

  function explainErr(e: unknown): string {
    const s = String(e);
    if (/MarketMissing/i.test(s)) {
      return "split failed: this market is not on the exchange yet. Wait a second and try again.";
    }
    if (/MarketSettledAlready/i.test(s)) {
      return "split failed: this market is already settled.";
    }
    if (localChain.id === 31337 && /nonce too high|nonce too low/i.test(s)) {
      return `${s} — Hardhat reset the chain nonce. In MetaMask (Hardhat Local): Settings → Advanced → Clear activity tab data, then retry.`;
    }
    if (/insufficient (collateral|balance)/i.test(s)) {
      return "insufficient balance — orders spend USDC deposited in the exchange, not the wallet balance. Faucet 1000, then deposit.";
    }
    return s;
  }

  /** Friendly toasts for place / close order failures; append backend body when present. */
  function placeOrderErrorMessage(e: unknown): string {
    const detail = (e instanceof Error ? e.message : String(e)).replace(/^Error:\s*/i, "").trim();
    if (/insufficient (collateral|balance)/i.test(detail)) return "Insufficient balance — deposit USDC first";
    if (/user rejected|user denied|rejected the request/i.test(detail)) return "Order cancelled";
    if (/GTD expires_at|expires_at must/i.test(detail)) return "Order expiry must be at least 1 minute from now";
    if (/market expiry unknown/i.test(detail)) return "Market expiry unknown — pick a date and time instead";
    if (/wallet\/rpc not ready|wallet not on/i.test(detail)) return "Connect your wallet and switch to the right network";
    if (/failed to fetch|networkerror|load failed/i.test(detail)) return "Failed to send order — network error";
    // Huge wallet/RPC dumps stay generic; short API bodies (e.g. POST /v1/orders) are shown.
    if (detail && detail.length <= 240 && !/UserOperation|TransactionExecutionError|Details: hex/i.test(detail)) {
      return `Failed to send order — ${detail}`;
    }
    return "Failed to send order";
  }

  async function latestNonce(): Promise<number> {
    if (!publicClient || !trader) throw new Error("wallet/rpc not ready");
    return publicClient.getTransactionCount({ address: trader, blockTag: "latest" });
  }

  async function markPending(op: "deposit" | "withdraw" | "split" | "merge", amount: bigint, tx: string, marketId = "") {
    if (!trader) return;
    await api.notePending({
      trader,
      op,
      amount: formatUnits(amount, 6),
      market_id: marketId,
      tx_hash: tx,
    });
  }

  /** Operator sends 10 Hardhat ETH + 1000 mock USDC to the connected wallet (not the exchange). */
  async function faucet() {
    if (!trader) return;
    try {
      const r = await api.faucet(trader);
      toast.success(`faucet 10 ETH + 1000 USDC → wallet · eth ${shortTx(r.eth_tx_hash)} · usdc ${shortTx(r.usdc_tx_hash)}`);
      refresh();
    } catch (e: unknown) {
      toast.error(explainErr(e));
    }
  }

  async function deposit() {
    if (!cfg) return;
    try {
      await ensureHardhat();
      const amt = parseUnits(dwAmt || "0", 6);
      await writeAsUser({
        chainId: localChain.id,
        address: cfg.usdc,
        abi: usdcAbi,
        functionName: "approve",
        args: [cfg.exchange, amt],
        nonce: await latestNonce(),
      });
      const dep = await writeAsUser({
        chainId: localChain.id,
        address: cfg.exchange,
        abi: exchangeAbi,
        functionName: "deposit",
        args: [amt],
        nonce: await latestNonce(),
      });
      await markPending("deposit", amt, dep);
      toast.success(`Successfully deposited $${Number(formatUnits(amt, 6)).toFixed(2)} USDC`);
      refresh();
    } catch (e: unknown) {
      toast.error(explainErr(e));
    }
  }

  async function withdraw() {
    if (!cfg) return;
    try {
      await ensureHardhat();
      const amt = parseUnits(dwAmt || "0", 6);
      const wd = await writeAsUser({
        chainId: localChain.id,
        address: cfg.exchange,
        abi: exchangeAbi,
        functionName: "withdraw",
        args: [amt],
        nonce: await latestNonce(),
      });
      await markPending("withdraw", amt, wd);
      toast.success(`Successfully withdrew $${Number(formatUnits(amt, 6)).toFixed(2)} USDC`);
      refresh();
    } catch (e: unknown) {
      toast.error(explainErr(e));
    }
  }

  async function redeem(marketId?: string) {
    const id = marketId || mid;
    if (!cfg || !id) return;
    try {
      await ensureHardhat();
      await writeAsUser({
        chainId: localChain.id,
        address: cfg.exchange,
        abi: exchangeAbi,
        functionName: "redeem",
        args: [marketIdHash(id)],
        nonce: await latestNonce(),
      });
      setSettledLocal((s) => new Set(s).add(id));
      toast.success("redeemed");
      refresh();
    } catch (e: unknown) {
      toast.error(explainErr(e));
    }
  }

  async function submitOrder(opts: {
    marketId: string;
    side: Side;
    price: number;
    size: string;
    tif: Tif;
    expiresAt: number;
    market: boolean;
    close?: boolean;
    postOnly?: boolean;
  }) {
    if (!cfg || !trader) return;
    if (placePhaseRef.current === "placing") return;
    const pxCents = opts.market ? (opts.close ? 0 : 99) : opts.price;
    const px = opts.market ? (opts.close ? 0 : MAX_DECICENTS) : centsToDecicents(opts.price);
    const useTif: Tif = opts.market ? "FAK" : opts.tif;
    const orderType = !opts.market && !opts.close && opts.postOnly ? "PostOnly" : "Limit";
    placePhaseRef.current = "placing";
    setPlacePhase("placing");
    try {
      await ensureHardhat();
      const nowSec = Math.floor(Date.now() / 1000);
      const minGtd = nowSec + (cfg.gtd_min_secs ?? 60);
      if (useTif === "GTD" && opts.expiresAt < minGtd) {
        throw new Error(`GTD expires_at must be unix seconds ≥ ${minGtd} (now+60s)`);
      }
      // Buys soft-lock USDC only for this market + Yes/No side (same deposit can cover every market).
      const need = Math.floor(((Number(opts.size) || 0) * px * 1_000_000) / 1000);
      const sideReserved = (acct?.open_orders ?? [])
        .filter((o) => o.market_id === opts.marketId && o.side === opts.side)
        .reduce((sum, o) => {
          const rem = Number(o.remaining);
          if (!Number.isFinite(rem)) return sum;
          return sum + Math.floor((rem * 1_000_000 * o.price) / 1000);
        }, 0);
      // Post-only rests only (maker); backend allows gas_fee 0.
      const gasFee =
        orderType === "PostOnly" ? 0 : Math.max(0, Math.floor(Number(cfg.gas_fee ?? 0)));
      const have = (acct?.collateral ?? 0) - sideReserved;
      const needWithGas = need + (opts.close ? 0 : gasFee);
      if (!opts.close && acct && have < needWithGas) {
        throw new Error(
          `insufficient balance: need ${(needWithGas / 1e6).toFixed(2)} USDC on this market side, have ${(Math.max(0, have) / 1e6).toFixed(2)}`
        );
      }
      const order: SignedOrder = {
        trader,
        market_id: opts.marketId,
        side: opts.side,
        price: px,
        size: opts.size,
        order_type: orderType,
        tif: useTif,
        nonce: Date.now(),
        salt: Math.floor(Math.random() * 1e12),
        expires_at: useTif === "GTD" ? opts.expiresAt : 0,
        gas_fee: gasFee,
        chain_id: cfg.chain_id,
        verifying_contract: cfg.exchange,
      };
      const signature = await signOrder(orderMessage(order));
      const r = await api.place({
        order,
        signature,
        agent_auth: sessionAgentAuth(),
        close: opts.close || undefined,
      });
      if ((r.fills?.length ?? 0) === 0 && r.reason) {
        const why =
          r.reason === "fak remainder"
            ? opts.close || opts.market
              ? "no matching liquidity"
              : `no ${opts.side.toUpperCase()} liquidity at ${pxCents}¢`
            : r.reason === "post-only"
              ? "would take liquidity (post-only)"
              : r.reason === "self-trade"
                ? "self-trade blocked"
                : "could not rest on the book";
        toast.error(`Order cancelled — ${why}`);
      } else if (opts.close) {
        toast.success("Successfully closed position");
      } else {
        toast.success("Successfully placed order");
      }
      refresh();
    } catch (e: unknown) {
      toast.error(placeOrderErrorMessage(e));
    } finally {
      placePhaseRef.current = "idle";
      setPlacePhase("idle");
    }
  }

  function place() {
    if (!mid) return;
    if (entryKind === "merge") return mergePos(mid, size);
    if (entryKind === "split") return splitPos(mid, size);
    if (entryKind === "market") {
      return submitOrder({
        marketId: mid,
        side,
        price,
        size,
        tif: "FAK",
        expiresAt: 0,
        market: true,
        close: intent === "sell",
      });
    }
    try {
      const resolved = resolveLimitExpiry(
        expiryChoice,
        appliedCustomExpiry,
        savedExpiry,
        market?.expires_at,
        Math.floor(Date.now() / 1000)
      );
      return submitOrder({
        marketId: mid,
        side,
        price,
        size,
        tif: resolved.tif,
        expiresAt: resolved.expiresAt,
        market: false,
        close: intent === "sell",
        postOnly: intent === "buy" && postOnly,
      });
    } catch (e: unknown) {
      toast.error(placeOrderErrorMessage(e));
    }
  }

  async function splitPos(marketId: string, sizeStr: string) {
    if (!cfg || !trader) return;
    try {
      const raw = parseUnits(sizeStr || "0", 6);
      if (raw <= 0n) throw new Error("size required");
      if (acct && BigInt(acct.available) < raw) {
        throw new Error(`insufficient balance: split needs ${sizeStr} USDC deposited`);
      }
      await ensureHardhat();
      const tx = await writeAsUser({
        chainId: localChain.id,
        address: cfg.exchange,
        abi: exchangeAbi,
        functionName: "split",
        args: [marketIdHash(marketId), raw],
        nonce: await latestNonce(),
      });
      await markPending("split", raw, tx, marketId);
      toast.success(`split ${sizeStr} submitted`);
      refresh();
    } catch (e: unknown) {
      toast.error(explainErr(e));
    }
  }

  async function mergePos(marketId: string, sizeStr?: string) {
    if (!cfg || !trader) return;
    try {
      const yes = positions.find((p) => p.marketId === marketId && p.side === "Yes");
      const no = positions.find((p) => p.marketId === marketId && p.side === "No");
      const yesN = Number(yes?.shares || 0);
      const noN = Number(no?.shares || 0);
      const cap = Math.min(yesN, noN);
      const n = sizeStr && Number(sizeStr) > 0 ? Math.min(Number(sizeStr), cap) : cap;
      if (!(n > 0)) throw new Error("need both yes and no");
      const raw = parseUnits(String(n), 6);
      await ensureHardhat();
      const tx = await writeAsUser({
        chainId: localChain.id,
        address: cfg.exchange,
        abi: exchangeAbi,
        functionName: "merge",
        args: [marketIdHash(marketId), raw],
        nonce: await latestNonce(),
      });
      await markPending("merge", raw, tx, marketId);
      toast.success(`merge ${n} submitted`);
      refresh();
    } catch (e: unknown) {
      toast.error(explainErr(e));
    }
  }

  function closePos(p: MinePos) {
    return submitOrder({
      marketId: p.marketId,
      side: p.side,
      price: 0,
      size: String(p.shares),
      tif: "FAK",
      expiresAt: 0,
      market: false,
      close: true,
    });
  }

  async function cancel(id: number, marketId: string) {
    if (!cfg || !trader || !marketId) return;
    try {
      await ensureHardhat();
      const nonce = Date.now();
      const signature = await signSessionOrUser(cancelTypes, "Cancel", {
        trader,
        orderId: BigInt(id),
        marketId,
        nonce: BigInt(nonce),
      });
      await api.cancel(id, {
        trader,
        market_id: marketId,
        nonce,
        signature,
        agent_auth: sessionAgentAuth(),
      });
      refresh();
    } catch (e: unknown) {
      toast.error(String(e));
    }
  }

  async function cancelAll() {
    if (!cfg || !trader) return;
    try {
      await ensureHardhat();
      const nonce = Date.now();
      const signature = await signSessionOrUser(cancelAllTypes, "CancelAll", {
        trader,
        marketId: cancelAllMarketId(),
        nonce: BigInt(nonce),
      });
      const r = await api.cancelAll({
        trader,
        nonce,
        signature,
        agent_auth: sessionAgentAuth(),
      });
      toast.success(`cancelled ${r.count}`);
      refresh();
    } catch (e: unknown) {
      toast.error(String(e));
    }
  }

  // Sort only while the markets dropdown is open — avoid O(n log n) on every quote/price tick.
  const history = useMemo(() => {
    if (!marketsOpen) return markets;
    return [...markets].sort((a, b) => {
      const d = barrierKey(b) - barrierKey(a);
      if (d > 0n) return 1;
      if (d < 0n) return -1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  }, [markets, marketsOpen]);
  const invertSide = side === "No";
  const chartPts = useMemo(() => {
    const raw = (chart?.points || [])
      .map((p) => {
        const n = centsNum(p.price);
        return n == null ? null : { t: p.ts, p: n };
      })
      .filter((x): x is { t: number; p: number } => x != null);
    return invertSide ? raw.map((pt) => ({ t: pt.t, p: 100 - pt.p })) : raw;
  }, [chart, invertSide]);
  /** Open orders for this market, priced in the chart's Y units (Yes mid or inverted No). */
  const chartOrderLines = useMemo(() => {
    const byKey = new Map<string, { price: number; side: Side; rem: number }>();
    for (const o of dbOrders) {
      if (o.market_id !== mid) continue;
      if (!isOpenOrderStatus(o.status)) continue;
      const rem = Number(o.remaining);
      if (!(rem > 0)) continue;
      const sidePx = decicentsToCents(o.price);
      if (!Number.isFinite(sidePx)) continue;
      // Chart Y is Yes¢, or No¢ when inverted — map each order into that frame.
      const chartPx = invertSide
        ? o.side === "No"
          ? sidePx
          : 100 - sidePx
        : o.side === "Yes"
          ? sidePx
          : 100 - sidePx;
      if (!(chartPx > 0) || !(chartPx < 100)) continue;
      const key = `${o.side}:${chartPx.toFixed(1)}`;
      const prev = byKey.get(key);
      if (prev) prev.rem += rem;
      else byKey.set(key, { price: chartPx, side: o.side, rem });
    }
    return [...byKey.values()].sort((a, b) => b.price - a.price);
  }, [dbOrders, mid, invertSide]);
  return (
    <>
      <ToastContainer
        position="bottom-right"
        theme="dark"
        autoClose={4000}
        newestOnTop
        closeOnClick
        pauseOnHover
        style={{ zIndex: 2147483647 }}
      />
      <dialog
        ref={customExpiryDialogRef}
        className="custom-expiry-dialog"
        onClose={() => setOverlay(null)}
        onPointerDown={onDialogBackdropPointerDown}
        onClick={onDialogBackdropClick}
      >
        <div className="custom-expiry-panel">
          <header className="fee-tiers-head">
            <h2>Custom Expiry</h2>
            <button
              type="button"
              className="fee-tiers-close"
              aria-label="Close"
              onClick={() => setOverlay(null)}
            >
              ×
            </button>
          </header>
          <div className="custom-expiry-modes" role="tablist" aria-label="Expiry mode">
            <button
              type="button"
              role="tab"
              aria-selected={customDraft.mode === "before_market"}
              className={customDraft.mode === "before_market" ? "on" : undefined}
              onClick={() => setCustomDraft((d) => ({ ...d, mode: "before_market" }))}
            >
              Before expiry
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={customDraft.mode === "absolute"}
              className={customDraft.mode === "absolute" ? "on" : undefined}
              onClick={() => setCustomDraft((d) => ({ ...d, mode: "absolute" }))}
            >
              Date &amp; time
            </button>
          </div>
          {customDraft.mode === "before_market" ? (
            <div className="custom-expiry-body">
              <p className="fee-tiers-note">
                Cancel the order this long before expiry
                {market?.expires_at
                  ? ` (${new Date(market.expires_at * 1000).toLocaleString()})`
                  : ""}
                .
              </p>
              <div className="row">
                <div className="field">
                  <label>hours</label>
                  <input
                    type="number"
                    min={0}
                    step={1}
                    value={Math.floor(customDraft.beforeSecs / 3600)}
                    onChange={(e) => {
                      const h = Math.max(0, Math.floor(Number(e.target.value) || 0));
                      const m = Math.floor((customDraft.beforeSecs % 3600) / 60);
                      setCustomDraft((d) => ({ ...d, beforeSecs: h * 3600 + m * 60 }));
                    }}
                    onWheel={(e) => e.currentTarget.blur()}
                  />
                </div>
                <div className="field">
                  <label>minutes</label>
                  <input
                    type="number"
                    min={0}
                    max={59}
                    step={1}
                    value={Math.floor((customDraft.beforeSecs % 3600) / 60)}
                    onChange={(e) => {
                      const m = Math.min(59, Math.max(0, Math.floor(Number(e.target.value) || 0)));
                      const h = Math.floor(customDraft.beforeSecs / 3600);
                      setCustomDraft((d) => ({ ...d, beforeSecs: h * 3600 + m * 60 }));
                    }}
                    onWheel={(e) => e.currentTarget.blur()}
                  />
                </div>
              </div>
              {market?.expires_at ? (
                <p className="sha custom-expiry-preview">
                  Order expires{" "}
                  {new Date((market.expires_at - customDraft.beforeSecs) * 1000).toLocaleString()}
                </p>
              ) : null}
            </div>
          ) : (
            <div className="custom-expiry-body">
              <p className="fee-tiers-note">Pick the date and time the order should expire.</p>
              <div className="field">
                <label>expires at</label>
                <input
                  type="datetime-local"
                  value={toDatetimeLocalValue(customDraft.atUnix || Math.floor(Date.now() / 1000) + 3600)}
                  onChange={(e) => {
                    const at = fromDatetimeLocalValue(e.target.value);
                    if (at > 0) setCustomDraft((d) => ({ ...d, atUnix: at }));
                  }}
                />
              </div>
            </div>
          )}
          <label className="custom-expiry-save">
            <input
              type="checkbox"
              checked={customDraftSave}
              onChange={(e) => setCustomDraftSave(e.target.checked)}
            />
            Save this option in the expires dropdown
          </label>
          <div className="custom-expiry-actions">
            <button type="button" onClick={() => setOverlay(null)}>
              Cancel
            </button>
            <button type="button" className="primary" onClick={applyCustomExpiry}>
              Apply
            </button>
          </div>
        </div>
      </dialog>
      <dialog
        ref={referDialogRef}
        className="account-dialog refer-dialog"
        onClose={() => setOverlay(null)}
        onPointerDown={onDialogBackdropPointerDown}
        onClick={onDialogBackdropClick}
      >
        <div className="account-panel">
          <header className="fee-tiers-head">
            <h2>Refer & Earn</h2>
            <button
              type="button"
              className="fee-tiers-close"
              aria-label="Close"
              onClick={() => setOverlay(null)}
            >
              ×
            </button>
          </header>
          <p className="fee-tiers-note">
            Share your link. When someone connects with it, they are attributed to your wallet.
          </p>
          <p className="fee-tiers-note">
            Referred volume is <strong>weighted</strong> the same way as fee volume:{" "}
            <code>shares × p × (1 − p)</code>, where <code>p</code> is the fill price in dollars
            (so weight is <code>p × (100 − p)</code> when price is in ¢). It peaks at 50¢ and is
            symmetric (30¢ = 70¢).
          </p>
          <div className="field">
            <label>your referral link</label>
            <div className="refer-link-row">
              <input
                readOnly
                value={trader ? referralLinkFor(trader) : ""}
                aria-label="Referral link"
                onFocus={(e) => e.currentTarget.select()}
              />
              <button
                type="button"
                className="primary"
                disabled={!trader}
                onClick={async () => {
                  if (!trader) return;
                  try {
                    await navigator.clipboard.writeText(referralLinkFor(trader));
                    toast.success("Referral link copied");
                  } catch {
                    toast.error("Could not copy link");
                  }
                }}
              >
                Copy
              </button>
            </div>
          </div>
          <p className="fee-tiers-note refer-wallet-note">
            Linked wallet <span className="sha">{trader ? shortAddr(trader) : "—"}</span>
          </p>
          <div className="refer-totals">
            <div>
              <span className="lbl">Referred taker vol</span>
              <strong>
                {fmtVolumeUsd((referrals?.referred_taker_volume ?? 0) / 1e6)}
              </strong>
            </div>
            <div>
              <span className="lbl">Referred maker vol</span>
              <strong>
                {fmtVolumeUsd((referrals?.referred_maker_volume ?? 0) / 1e6)}
              </strong>
            </div>
            <div>
              <Tooltip content="Taker fees generated by referred wallets">
                <span className="lbl refer-fees-lbl">Referred Fees</span>
              </Tooltip>
              <strong>
                {fmtVolumeUsd((referrals?.referred_taker_fees ?? 0) / 1e6)}
              </strong>
            </div>
          </div>
          <div className="refer-list-wrap">
            <label>referred wallets</label>
            {referralsLoading ? (
              <p className="fee-tiers-note">Loading…</p>
            ) : !referrals?.referrals?.length ? (
              <p className="fee-tiers-note">No referrals yet.</p>
            ) : (
              <table className="refer-table">
                <thead>
                  <tr>
                    <th>Wallet</th>
                    <th>Taker</th>
                    <th>Maker</th>
                    <th>Fees</th>
                  </tr>
                </thead>
                <tbody>
                  {referrals.referrals.map((r) => (
                    <tr key={r.trader}>
                      <td className="sha" title={r.trader}>
                        {shortAddr(r.trader)}
                      </td>
                      <td>{fmtVolumeUsd(r.taker_volume / 1e6)}</td>
                      <td>{fmtVolumeUsd(r.maker_volume / 1e6)}</td>
                      <td>{fmtVolumeUsd((r.taker_fees ?? 0) / 1e6)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </dialog>
      <dialog
        ref={accountDialogRef}
        className="account-dialog"
        onClose={() => setOverlay(null)}
        onPointerDown={onDialogBackdropPointerDown}
        onClick={onDialogBackdropClick}
      >
        <div className="account-panel">
          <header className="fee-tiers-head">
            <h2>Account</h2>
            <button
              type="button"
              className="fee-tiers-close"
              aria-label="Close"
              onClick={() => setOverlay(null)}
            >
              ×
            </button>
          </header>
          <p className="fee-tiers-note">
            Sign a short message with your wallet to save nickname or email. We email a 6-digit code; enter it here to verify.
          </p>
          <div className="field">
            <label>nickname</label>
            <input
              value={nickDraft}
              onChange={(e) => setNickDraft(e.target.value)}
              placeholder="3–24 chars"
              maxLength={24}
              autoComplete="nickname"
            />
          </div>
          <div className="account-actions">
            <button type="button" className="primary" disabled={accountBusy || !walletOn} onClick={saveNickname}>
              Save nickname
            </button>
          </div>
          <div className="field">
            <label>
              email
              {acct?.email_verified ? <span className="account-verified"> verified</span> : null}
            </label>
            <input
              type="email"
              value={emailDraft}
              onChange={(e) => setEmailDraft(e.target.value)}
              placeholder="you@example.com"
              autoComplete="email"
            />
          </div>
          <div className="account-actions">
            <button type="button" className="primary" disabled={accountBusy || !walletOn} onClick={saveEmail}>
              Save email
            </button>
          </div>
          {(emailVerifyPending || (acct?.email && !acct.email_verified)) && (
            <>
              <div className="field">
                <label>verification code</label>
                <input
                  value={emailCodeDraft}
                  onChange={(e) => setEmailCodeDraft(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  placeholder="6 digits"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                />
              </div>
              <div className="account-actions">
                <button
                  type="button"
                  disabled={accountBusy || !walletOn || emailResendAfter > nowSec}
                  onClick={resendEmailCode}
                >
                  {emailResendAfter > nowSec
                    ? `Resend in ${emailResendAfter - nowSec}s`
                    : "Resend code"}
                </button>
                <button type="button" className="primary" disabled={accountBusy || !walletOn} onClick={submitEmailCode}>
                  Verify email
                </button>
              </div>
            </>
          )}
        </div>
      </dialog>
      <dialog
        ref={feeTiersDialogRef}
        className="fee-tiers-dialog"
        onClose={() => setOverlay(null)}
        onPointerDown={onDialogBackdropPointerDown}
        onClick={onDialogBackdropClick}
      >
        <form method="dialog" className="fee-tiers-panel" onSubmit={() => setOverlay(null)}>
          <header className="fee-tiers-head">
            <h2>Fee tiers</h2>
            <button type="submit" className="fee-tiers-close" aria-label="Close">
              ×
            </button>
          </header>
          <p className="fee-tiers-note">
            Only <strong>takers</strong> pay a fee. Makers pay nothing. The fee uses a{" "}
            <strong>coefficient</strong>, not a flat % of notional:
          </p>
          <pre className="fee-tiers-formula">fee = shares × coefficient × p × (1 − p)</pre>
          <p className="fee-tiers-note">
            <code>p</code> is the fill price in dollars (e.g. 0.40 at 40¢). The{" "}
            <code>p × (1 − p)</code> curve peaks at 50¢ and is symmetric (30¢ = 70¢).
          </p>
          <div className="fee-tiers-volume">
            <div className="fee-tiers-volume-row">
              <span>
                Your 30d weighted volume: <strong>{fmtVolumeUsd(volume30d)}</strong>
                <span className="sha"> · tier {feeTier.tier} ({feeTier.label})</span>
              </span>
              <span className="sha">
                {feeProgress.next
                  ? `${fmtVolumeUsd(feeProgress.remaining)} to ${feeProgress.next.label}`
                  : "top tier"}
              </span>
            </div>
            <div
              className="fee-tiers-progress"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(feeProgress.pct)}
              aria-label={
                feeProgress.next
                  ? `Progress to ${feeProgress.next.label}`
                  : "Top fee tier reached"
              }
            >
              <div className="fee-tiers-progress-fill" style={{ width: `${feeProgress.pct}%` }} />
            </div>
            <p className="fee-tiers-note">
              Weighted volume (wV) is snapshotted hourly (UTC :00, and on boot) into your
              account — only <strong>taker</strong> fills over the last 30 days count.
            </p>
            <pre className="fee-tiers-formula">wV = shares × p × (1 − p)</pre>
            <p className="fee-tiers-note">
              <code>p</code> is the fill price in dollars. Maker fills, merges, splits, and
              redeems do not earn wV. Makers do not pay any fees — only takers do.
            </p>
          </div>
          <table className="fee-tiers-table">
            <thead>
              <tr>
                <th className="left">Tier</th>
                <th className="left">30d weighted vol</th>
                <th>taker coeff</th>
              </tr>
            </thead>
            <tbody>
              {FEE_TIERS.map((t) => {
                const active = t.tier === feeTier.tier;
                return (
                  <tr key={t.tier} className={active ? "me" : undefined}>
                    <td className="left">{t.tier}</td>
                    <td className="left">{t.label}</td>
                    <td>{fmtTakerFeeCoeff(t.takerCoeff)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </form>
      </dialog>
      <header>
        <a className="brand" href="https://arizal.xyz/" title="Arizal home">
          <img className="brand-mark" src="/logo.svg" alt="" width={20} height={20} />
          arizal<span>.xyz</span>
        </a>
        {connHealth === "reconnecting" && <span className="conn-down">connection failed, reconnecting</span>}
        <div className="header-right">
          <div className="header-balances">
            <span className="bal">
              <span className="lbl">Portfolio</span>{" "}
              <strong>{acct ? Number(formatUnits(BigInt(acct.collateral), 6)).toFixed(2) : "—"}</strong>
            </span>
            <span className="bal">
              <span className="lbl">Cash</span>{" "}
              <strong>{acct ? Number(formatUnits(BigInt(acct.available), 6)).toFixed(2) : "—"}</strong>
            </span>
          </div>
          <div className="header-funds">
            <input
              className="dw-amt"
              value={dwAmt}
              onChange={(e) => setDwAmt(e.target.value)}
              aria-label="Deposit / withdraw amount"
            />
            <button type="button" onClick={faucet} disabled={!walletOn}>
              Faucet
            </button>
            <button type="button" onClick={deposit} disabled={!walletOn}>
              deposit
            </button>
            <button type="button" onClick={withdraw} disabled={!walletOn}>
              withdraw
            </button>
          </div>
          <div className="connect">
            {isConnected && trader ? (
              <>
                {!onHardhat && (
                  <button className="no" onClick={() => ensureHardhat().catch((e) => toast.error(String(e)))}>
                    switch network
                  </button>
                )}
                <div
                  ref={walletMenuRef}
                  className={`wallet-menu${walletMenuOpen ? " open" : ""}`}
                  onMouseLeave={(e) => {
                    const active = document.activeElement;
                    if (active instanceof HTMLElement && e.currentTarget.contains(active)) active.blur();
                  }}
                >
                  <button
                    type="button"
                    className="wallet-menu-trigger"
                    aria-haspopup="menu"
                    aria-expanded={walletMenuOpen}
                    onClick={() => setWalletMenuOpen((o) => !o)}
                  >
                    <WalletGlyph address={trader} />
                    <span className={acct?.nickname ? "wallet-nick" : "sha"}>
                      {acct?.nickname?.trim() || shortAddr(trader)}
                    </span>
                  </button>
                  <div className="wallet-menu-drop" role="menu">
                    <div className="wallet-menu-drop-inner">
                      <div className="wallet-menu-addr">
                        <span className="sha" title={trader}>
                          {shortAddr(trader)}
                        </span>
                        <button
                          type="button"
                          className="wallet-menu-copy"
                          aria-label="Copy address"
                          onClick={async (e) => {
                            e.stopPropagation();
                            try {
                              await navigator.clipboard.writeText(trader);
                              toast.success("Address copied");
                            } catch {
                              toast.error("Could not copy address");
                            }
                          }}
                        >
                          Copy
                        </button>
                      </div>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setWalletMenuOpen(false);
                          openAccountDialog();
                        }}
                      >
                        Account
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setWalletMenuOpen(false);
                          openReferDialog();
                        }}
                      >
                        Refer & Earn
                      </button>
                      <a
                        className="wallet-menu-link"
                        role="menuitem"
                        href="https://docs.arizal.xyz/"
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={() => setWalletMenuOpen(false)}
                      >
                        Docs
                      </a>
                      <button
                        type="button"
                        role="menuitem"
                        className="wallet-menu-disconnect"
                        onClick={() => {
                          setWalletMenuOpen(false);
                          disconnect();
                        }}
                      >
                        Disconnect
                      </button>
                    </div>
                  </div>
                </div>
              </>
            ) : (
              <button
                type="button"
                className="connect-wallet"
                onClick={() => appKit.open({ view: "Connect" })}
              >
                Connect wallet
              </button>
            )}
          </div>
        </div>
      </header>
      <MarketPicker
        market={market ?? null}
        quote={bestBidAsk(book)}
        spotRaw={spotRaw}
        nowSec={nowSec}
        open={marketsOpen}
        onToggle={() => setOverlay((o) => (o === "markets" ? null : "markets"))}
        rows={history}
        quotes={quotesById}
        marketsTab={marketsTab}
        onMarketsTab={setMarketsTab}
        marketsTf={marketsTf}
        onMarketsTf={setMarketsTf}
        mine={gridMine}
        priceDp={priceDp}
        onOpen={(id, nextSide) => {
          openMarket(id, "push", nextSide);
          setOverlay(null);
        }}
      />
      <div className="grid" data-mobile-tab={mobileTab}>
        <div className="panel chart">
          <div className="chart-head">
            {market?.status === "Resolved" && <div className="resolved">RESOLVED</div>}
            {(market?.kind || "hit") === "hit" && (
              <div className="resolved-history">
                <button type="button" className="history-btn" aria-label="Resolved market history" title="Resolved history">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path
                      d="M12 8v5l3 2"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                    <path
                      d="M3.5 12a8.5 8.5 0 1 0 2.2-5.6"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                    />
                    <path d="M3.5 4.5v4h4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  {resolvedStrike.length > 0 && <span className="history-count">{resolvedStrike.length}</span>}
                </button>
                <div className="resolved-drop" role="menu">
                  <div className="resolved-drop-head">Resolved markets</div>
                  {resolvedStrike.length === 0 ? (
                    <div className="empty">no prior resolves for this expiry</div>
                  ) : (
                    <table>
                      <thead>
                        <tr>
                          <th>resolved</th>
                          <th>dir</th>
                          <th>expiry</th>
                          <th>winner</th>
                          <th>spot</th>
                        </tr>
                      </thead>
                      <tbody>
                        {resolvedStrike.map((m) => (
                          <tr
                            key={m.id}
                            className={m.id === mid ? "me" : undefined}
                            onClick={() => openMarket(m.id, "push")}
                            title={m.id}
                          >
                            <td>{fmtResolvedAt(m.resolved_at)}</td>
                            <td className={m.direction === "up" ? "yes" : "no"}>
                              {(m.direction || "up").toUpperCase()}
                            </td>
                            <td>
                              <ExpiryPill market={m} marketId={m.id} nowSec={nowSec} />
                            </td>
                            <td className={m.winning_side === "Yes" ? "yes" : m.winning_side === "No" ? "no" : undefined}>
                              {m.winning_side?.toUpperCase() || "—"}
                            </td>
                            <td className="mono">{fmtAssetPx(m.resolution_price, priceDpFor(cfg, marketAsset(m)))}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </div>
            )}
            {market?.status !== "Resolved" && market?.expires_at ? (
              <LiveCountdown expiresAt={market.expires_at} className="chart-countdown" title="Time to expiry" />
            ) : null}
            <div className="tabs tf-tabs">
              {CHART_TF.map(([label]) => (
                <button key={label} className={chartTf === label ? "active" : ""} onClick={() => setChartTf(label)}>
                  {label}
                </button>
              ))}
            </div>
          </div>
          <MidChart
            points={chartPts}
            startTs={chart?.start_ts ?? 0}
            endTs={chart?.end_ts || chart?.now_ts || nowSec}
            nowTs={chart?.now_ts ?? nowSec}
            color={invertSide ? "#e06a5c" : "#3dba7a"}
            orderLines={chartOrderLines}
          />
        </div>

        <div className="panel book">
          <div className="book-head">
            <h2>Order book {market?.status}</h2>
            <div className="tabs">
              <button className={side === "Yes" ? "yes active" : ""} onClick={() => setSide("Yes")}>
                YES
              </button>
              <button className={side === "No" ? "no active" : ""} onClick={() => setSide("No")}>
                NO
              </button>
            </div>
          </div>
          <BookLadder
            asks={depth.asks}
            bids={depth.bids}
            mineAsks={mineLevels.asks}
            mineBids={mineLevels.bids}
            onPick={(px, cumShares) => {
              setPrice(px);
              if (cumShares > 0) setSize(String(Number(cumShares.toFixed(6))));
            }}
            onCancelMine={(orderIds) => {
              for (const id of orderIds) cancel(id, mid);
            }}
          />
        </div>

        <div className="panel place">
          <h2>Place order</h2>
          <div className="stack">
            {entryKind !== "merge" && entryKind !== "split" && (
              <>
                <div className="row">
                  <button className={intent === "buy" ? "yes" : ""} onClick={() => setIntent("buy")}>
                    BUY
                  </button>
                  <button className={intent === "sell" ? "no" : ""} onClick={() => setIntent("sell")}>
                    SELL
                  </button>
                </div>
                <div className="row">
                  <button className={side === "Yes" ? "yes" : ""} onClick={() => setSide("Yes")}>
                    YES
                  </button>
                  <button className={side === "No" ? "no" : ""} onClick={() => setSide("No")}>
                    NO
                  </button>
                </div>
              </>
            )}
            <div className="row">
              <div className="field">
                <label>type</label>
                <select value={entryKind} onChange={(e) => setEntryKind(e.target.value as "limit" | "market" | "merge" | "split")}>
                  <option value="limit">limit</option>
                  <option value="market">market</option>
                  <option value="merge">merge</option>
                  <option value="split">split</option>
                </select>
              </div>
              {entryKind === "limit" && (
                <div className="field">
                  <label>{intent === "sell" ? "min ¢" : "price ¢"}</label>
                  <div className="price-stepper">
                    <button
                      type="button"
                      className="price-step"
                      aria-label="Decrease price 1¢"
                      disabled={price <= 1}
                      onClick={() => setPrice((p) => Math.max(1, Math.min(99, (Number(p) || 0) - 1)))}
                    >
                      −
                    </button>
                    <input
                      type="number"
                      min={1}
                      max={99}
                      value={price}
                      onChange={(e) => {
                        const n = +e.target.value;
                        if (!Number.isFinite(n)) return;
                        setPrice(Math.max(1, Math.min(99, Math.round(n))));
                      }}
                      onWheel={(e) => e.currentTarget.blur()}
                    />
                    <button
                      type="button"
                      className="price-step"
                      aria-label="Increase price 1¢"
                      disabled={price >= 99}
                      onClick={() => setPrice((p) => Math.max(1, Math.min(99, (Number(p) || 0) + 1)))}
                    >
                      +
                    </button>
                  </div>
                </div>
              )}
              <div className="field">
                <label>{entryKind === "merge" || entryKind === "split" ? "pairs" : "size"}</label>
                <div className="input-clear">
                  <input
                    type="number"
                    min={0.000001}
                    step="0.01"
                    value={size}
                    onChange={(e) => setSize(e.target.value)}
                    onWheel={(e) => e.currentTarget.blur()}
                  />
                  {size !== "" && (
                    <button type="button" className="clear" aria-label="Clear size" onClick={() => setSize("")}>
                      ×
                    </button>
                  )}
                </div>
              </div>
              {entryKind === "limit" && (
                <div className="field">
                  <label>expires</label>
                  <select
                    value={expiryChoice}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (v === "__custom__") {
                        openCustomExpiryDialog();
                        return;
                      }
                      setExpiryChoice(v as ExpiryChoice);
                    }}
                  >
                    <option value="never">Never</option>
                    <option value="5m">5m</option>
                    <option value="1h">1h</option>
                    <option value="12h">12h</option>
                    <option value="24h">24h</option>
                    {savedExpiry && (
                      <option value="saved">{fmtCustomExpiryLabel(savedExpiry)}</option>
                    )}
                    {expiryChoice === "custom" && appliedCustomExpiry && (
                      <option value="custom">{fmtCustomExpiryLabel(appliedCustomExpiry)}</option>
                    )}
                    <option value="__custom__">Custom…</option>
                  </select>
                </div>
              )}
            </div>
            {(entryKind === "limit" || entryKind === "market") && (
              <div className="row size-presets">
                {([1, 5, 10, 25, 50] as const).map((n) => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => {
                      const next = (Number(size) || 0) + n;
                      setSize(String(Number(next.toFixed(6))));
                    }}
                  >
                    +{n}
                  </button>
                ))}
              </div>
            )}
            {entryKind === "limit" && intent === "buy" && (
              <label className="post-only-check">
                <input
                  type="checkbox"
                  checked={postOnly}
                  onChange={(e) => setPostOnly(e.target.checked)}
                />
                Post only
              </label>
            )}
            <button
              className={`go ${intent}`}
              disabled={!walletOn || placePhase === "placing"}
              onClick={place}
            >
              {placePhase === "placing"
                ? "Placing…"
                : entryKind === "merge" || entryKind === "split"
                  ? entryKind
                  : `${intent === "sell" ? "SELL" : "BUY"} ${side.toUpperCase()}`}
            </button>
            {(() => {
              const n = Number(size) || 0;
              type Row = {
                label: ReactNode;
                key: string;
                value: ReactNode;
                valueClass?: string;
                feeHelp?: boolean;
              };
              const rows: Row[] = [];
              const feePctRow = (): Row => ({
                key: "fee coef",
                label: "fee coef",
                feeHelp: true,
                value:
                  walletTakerCoeff != null
                    ? `${fmtTakerFeeCoeff(0)}/${fmtTakerFeeCoeff(walletTakerCoeff)}`
                    : "—",
              });
              // Live GET /v1/config + WS `config` gas_fee (USDC raw). Post-only makers pay 0.
              const takerGasFeeRow = (): Row => {
                const postOnlyMaker = entryKind === "limit" && intent === "buy" && postOnly;
                const label = (
                  <Tooltip content="Transaction gas fee is paid by the taker. Use Post only to make sure order can't be a taker.">
                    taker gas fee
                  </Tooltip>
                );
                if (postOnlyMaker) return { key: "taker gas fee", label, value: "$0.00" };
                const raw = cfg?.gas_fee;
                if (raw == null || !Number.isFinite(Number(raw))) {
                  return { key: "taker gas fee", label, value: "—" };
                }
                return {
                  key: "taker gas fee",
                  label,
                  value: `$${(Number(raw) / 1e6).toFixed(2)}`,
                };
              };
              if (entryKind === "market") {
                const levels = intent === "sell" ? depth.bids : depth.asks;
                const vwap = approxVwapDecicents(levels, n);
                const pxCents = vwap != null ? decicentsToCents(vwap) : null;
                const notional = pxCents != null && n > 0 ? (n * pxCents) / 100 : null;
                if (intent === "buy" && notional != null) {
                  const profit = n - notional;
                  const pct = notional > 0 ? (profit / notional) * 100 : 0;
                  rows.push({ key: "cost", label: "cost", value: `$${notional.toFixed(2)}` });
                  rows.push({
                    key: "profit on win",
                    label: "profit on win",
                    value: `$${profit.toFixed(2)} (${pct.toFixed(0)}%)`,
                    valueClass: "payout",
                  });
                } else if (intent === "sell") {
                  rows.push({
                    key: "proceeds",
                    label: "proceeds",
                    value: notional != null ? `≈ ${notional.toFixed(2)} USDC` : "into bids",
                  });
                }
                rows.push({
                  key: "exec",
                  label: "≈ exec",
                  value: vwap == null ? "—" : `${fmtPriceDecicents(Math.round(vwap))}¢`,
                });
                rows.push(feePctRow());
                rows.push(takerGasFeeRow());
              } else if (entryKind === "split") {
                rows.push({
                  key: "locks",
                  label: "locks",
                  value: `${n.toFixed(2)} USDC → YES + NO @ 50¢`,
                });
              } else if (entryKind === "merge") {
                rows.push({ key: "returns", label: "returns", value: `≈ ${n.toFixed(2)} USDC` });
              } else if (entryKind === "limit") {
                const notional = n > 0 && price > 0 ? (n * price) / 100 : null;
                if (intent === "sell") {
                  rows.push({
                    key: "sell",
                    label: "sell",
                    value: `${n || 0} ${side.toUpperCase()} ≥ ${price}¢`,
                  });
                } else {
                  const cost = notional ?? 0;
                  const profit = n - cost;
                  const pct = cost > 0 ? (profit / cost) * 100 : 0;
                  rows.push({ key: "cost", label: "cost", value: `$${cost.toFixed(2)}` });
                  rows.push({
                    key: "profit on win",
                    label: "profit on win",
                    value: `$${profit.toFixed(2)} (${pct.toFixed(0)}%)`,
                    valueClass: "payout",
                  });
                }
                rows.push(feePctRow());
                rows.push(takerGasFeeRow());
              }
              if (rows.length === 0) return null;
              return (
                <table className="place-summary">
                  <tbody>
                    {rows.map((r) => (
                      <tr
                        key={r.key}
                        className={r.feeHelp ? "fee-help-row" : undefined}
                        onClick={r.feeHelp ? () => setOverlay("fees") : undefined}
                        title={r.feeHelp ? "Fee tiers & 30d volume" : undefined}
                      >
                        <td className="lbl">{r.label}</td>
                        <td className={`val${r.valueClass ? ` ${r.valueClass}` : ""}`}>{r.value}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              );
            })()}
            {tradingSession !== "disconnected" && (
              <div className="session-auth">
                {tradingSession === "on" ? (
                  <>
                    <span className="ok">session wallet authorized</span>
                    {" · "}
                    <button type="button" className="link" onClick={() => void disableTrading()}>
                      revoke
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="link"
                    disabled={!cfg}
                    onClick={() => void enableTrading()}
                  >
                    Enable 1-click trading
                  </button>
                )}
              </div>
            )}
            {market?.status === "Resolved" &&
              (settledLocal.has(mid) || positions.some((p) => p.marketId === mid && p.redeemed) ? (
                <span className="sha">Redeemed</span>
              ) : positions.some((p) => p.marketId === mid && Number(p.shares) > 0) ? (
                <button className="primary" onClick={() => redeem()}>
                  Redeem {market.winning_side?.toUpperCase()}
                </button>
              ) : null)}
          </div>
        </div>

        <div className="panel trades">
          <h2>Trades</h2>
          <div className="panel-scroll">
          <table>
            <thead>
              <tr>
                <th className="al">op</th>
                <th>px</th>
                <th>size</th>
                <th className="al">status</th>
                <th className="left">tx</th>
                <th>time</th>
              </tr>
            </thead>
            <tbody>
              {trades.length === 0 && (
                <tr>
                  <td colSpan={6} className="left">
                    no fills
                  </td>
                </tr>
              )}
              {trades.map((t) => {
                // Express every fill in the selected Yes/No frame (BUY NO @ p ↔ SELL YES @ 100−p).
                const tradeSide = t.close_side || t.taker_side;
                const nativeSell = !!t.close_side;
                const selling = tradeSide === side ? nativeSell : !nativeSell;
                const sidePx = side === "No" ? complementAsk(t.yes_price) : t.yes_price;
                const booked = t.close_side
                  ? myFills.find(
                      (m) =>
                        m.op === "close" &&
                        m.closing &&
                        m.marketId === t.market_id &&
                        m.side === t.close_side &&
                        Math.abs(Number(m.shares) - Number(t.size)) < 1e-6 &&
                        Math.abs((m.ts || 0) - t.ts_engine) <= 5
                    )
                  : undefined;
                const bookedHash = (booked?.txHash || "").startsWith("0x") ? booked!.txHash! : "";
                const mined = (fillTx[t.fill_id] || "").startsWith("0x") ? fillTx[t.fill_id] : "";
                const sent = (t.tx_hash || "").startsWith("0x") ? t.tx_hash! : "";
                const hash = sent || mined || bookedHash;
                const confirmed = !!t.confirmed || !!mined || booked?.status === "confirmed";
                return (
                  <tr key={`${t.market_id}-${t.ts_engine}-${t.fill_id}-${t.close_side ?? "buy"}`}>
                    <td className={selling ? "no al" : "yes al"}>{selling ? "SELL" : "BUY"}</td>
                    <td>{fmtPriceDecicents(sidePx)}¢</td>
                    <td>{fmtShares(t.size)}</td>
                    <td className="sha al">{confirmed ? "confirmed" : "pending"}</td>
                    <td className="sha left">{shortTx(hash)}</td>
                    <td className="sha" title={t.ts_engine ? new Date(t.ts_engine * 1000).toISOString() : undefined}>
                      {fmtLocalTime(t.ts_engine)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        </div>

        <div className="panel mine">
          <div className="tabs">
            <button className={mineTab === "positions" ? "active" : ""} onClick={() => setMineTab("positions")}>
              Positions
            </button>
            <button className={mineTab === "orders" ? "active" : ""} onClick={() => setMineTab("orders")}>
              Orders
            </button>
            <button className={mineTab === "history" ? "active" : ""} onClick={() => setMineTab("history")}>
              History
            </button>
            <button className={mineTab === "funds" ? "active" : ""} onClick={() => setMineTab("funds")}>
              Funds
            </button>
            {mineTab === "orders" && walletOn && dbOrders.length > 0 && (
              <button className="cancel-all" onClick={cancelAll}>
                cancel all
              </button>
            )}
          </div>
          <div className="panel-scroll">
          {!walletOn ? (
            <div className="sha">connect wallet</div>
          ) : mineTab === "history" ? (
            <table>
              <thead>
                <tr>
                  <th className="left">market</th>
                  <th className="al">op</th>
                  <th className="al">side</th>
                  <th>px</th>
                  <th>size</th>
                  <th>pnl</th>
                  <th>fee</th>
                  <th>value</th>
                  <th className="al">status</th>
                  <th className="left">tx</th>
                  <th>time</th>
                </tr>
              </thead>
              <tbody>
                {myFills.length === 0 && (
                  <tr>
                    <td colSpan={11} className="left">
                      no history
                    </td>
                  </tr>
                )}
                {myFills.map((t) => {
                  const pending = t.status === "pending";
                  const pair = t.op === "merge" || t.op === "split";
                  const settle = t.op === "settle";
                  const sell = !pair && !settle && (!!t.closing || t.op === "close");
                  const op = (settle ? "redeem" : pair ? t.op || "" : sell ? "sell" : "buy").toUpperCase();
                  const opCls = settle
                    ? "op-redeem al"
                    : t.op === "split"
                      ? "op-split al"
                      : t.op === "merge"
                        ? "op-merge al"
                        : sell
                          ? "no al"
                          : "yes al";
                  const unsettled = pending || t.status === "failed";
                  const pnl = unsettled ? null : settle || sell ? (t.pnl ?? 0) / 1e6 : 0;
                  const fee = pair || settle || unsettled || !t.isTaker ? null : (t.fee ?? 0) / 1e6;
                  // Notional USDC: trades = shares × p; redeem/merge/split = $1 per share/pair.
                  const value =
                    unsettled || !(t.shares > 0)
                      ? null
                      : settle || pair
                        ? t.shares
                        : t.price > 0
                          ? t.shares * (t.price / 1000)
                          : null;
                  const pxLabel = pair ? "—" : settle ? "$1" : `${fmtPriceDecicents(t.price)}¢`;
                  return (
                    <tr key={`${t.txHash}-${t.logIndex}-${t.side}-${t.op}-${t.id}`} onClick={() => openMarket(t.marketId)} style={{ cursor: "pointer" }}>
                      <td className="left">
                        <MarketTitlePills
                          market={markets.find((m) => m.id === t.marketId)}
                          marketId={t.marketId}
                          spotUsd={pxToUsd(spotRaw)}
                          nowSec={nowSec}
                          priceDp={priceDpFor(cfg, marketAsset(markets.find((m) => m.id === t.marketId) || { id: t.marketId }))}
                        />
                      </td>
                      <td className={opCls}>{op}</td>
                      <td className={pair ? "al" : t.side === "Yes" ? "yes al" : "no al"}>{pair ? "—" : t.side.toUpperCase()}</td>
                      <td>{pxLabel}</td>
                      <td>{fmtShares(t.shares)}</td>
                      <td className={pnl == null ? "" : pnl < 0 ? "no" : pnl > 0 ? "yes" : ""}>
                        {pnl == null ? "—" : fmtSignedUsdNum(pnl)}
                      </td>
                      <td className={fee == null ? "sha" : "no"}>{fee == null ? "—" : fmtUsdNum(fee)}</td>
                      <td>{value == null ? "—" : fmtUsdNum(value)}</td>
                      <td className="sha al">
                        {t.status === "pending" ? "pending" : t.status === "failed" ? "failed" : "confirmed"}
                      </td>
                      <td className="sha left">{shortTx(t.txHash)}</td>
                      <td>{fmtLocalDateTime(t.ts)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : mineTab === "funds" ? (
            <table>
              <thead>
                <tr>
                  <th>op</th>
                  <th>amount</th>
                  <th>time</th>
                  <th>st</th>
                  <th>blk</th>
                  <th>log</th>
                  <th className="left">tx</th>
                </tr>
              </thead>
              <tbody>
                {funds.length === 0 && (
                  <tr>
                    <td colSpan={7} className="left">
                      no deposits or withdrawals
                    </td>
                  </tr>
                )}
                {funds.map((f) => (
                  <tr key={`${f.tx_hash}-${f.ts}-${f.kind}-${f.status}`}>
                    <td className={f.kind === "deposit" ? "yes" : "no"}>{f.kind}</td>
                    <td>{fmtUsdc(f.amount)}</td>
                    <td>{fmtLocalTime(f.ts)}</td>
                    <td className={f.status === "pending" ? "sha" : ""}>{f.status === "pending" ? "pending" : "confirmed"}</td>
                    <td>{f.status === "pending" || !f.block ? "—" : f.block}</td>
                    <td>{f.status === "pending" || (f.log_index ?? -1) < 0 ? "—" : f.log_index}</td>
                    <td className="left">{shortTx(f.tx_hash)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : mineTab === "orders" ? (
            <table>
              <thead>
                <tr>
                  <th className="left">market</th>
                  <th className="al">op</th>
                  <th>side</th>
                  <th>px</th>
                  <th>left</th>
                  <th>tif</th>
                  <th>expires</th>
                  <th>st</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {dbOrders.length === 0 && (
                  <tr>
                    <td colSpan={9} className="left">
                      no open orders
                    </td>
                  </tr>
                )}
                {dbOrders.map((o) => {
                  const expAt = o.expires_at && o.expires_at > 0 ? o.expires_at : 0;
                  return (
                  <tr key={o.id} onClick={() => openMarket(o.market_id)} style={{ cursor: "pointer" }}>
                    <td className="left">
                      <MarketTitlePills
                        market={markets.find((m) => m.id === o.market_id)}
                        marketId={o.market_id}
                        spotUsd={pxToUsd(spotRaw)}
                        nowSec={nowSec}
                        priceDp={priceDpFor(cfg, marketAsset(markets.find((m) => m.id === o.market_id) || { id: o.market_id }))}
                      />
                    </td>
                    <td className="yes al">BUY</td>
                    <td className={o.side === "Yes" ? "yes" : "no"}>{o.side.toUpperCase()}</td>
                    <td>{fmtPriceDecicents(o.price)}¢</td>
                    <td>
                      {fmtShares(o.remaining, 1)}/{fmtShares(o.size, 1)}
                    </td>
                    <td>{o.tif || ""}</td>
                    <td title={expAt ? new Date(expAt * 1000).toLocaleString() : "Never"}>
                      {expAt ? fmtOrderExpiresLeft(expAt, nowSec) : "Never"}
                    </td>
                    <td>{o.status}</td>
                    <td>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          cancel(o.id, o.market_id);
                        }}
                      >
                        cancel
                      </button>
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <table>
              <thead>
                <tr>
                  <th className="left">market</th>
                  <th className="al">side</th>
                  <th>shares</th>
                  <th>entry</th>
                  <th>mid</th>
                  <th>cost</th>
                  <th>value</th>
                  <th>pnl</th>
                  <th>Exp</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {(() => {
                  // Active markets + unredeemed winning resolved sides (losing resolved hidden).
                  const rows = positions.filter((p) => {
                    if (Number(p.shares) <= 0 || p.redeemed) return false;
                    const mkt = markets.find((m) => m.id === p.marketId);
                    if (!mkt || mkt.status !== "Resolved") return true;
                    return !!mkt.winning_side && mkt.winning_side === p.side;
                  });
                  if (rows.length === 0) {
                    return (
                      <tr>
                        <td colSpan={10} className="left">
                          no positions
                        </td>
                      </tr>
                    );
                  }
                  return rows.map((p) => {
                    const mkt = markets.find((m) => m.id === p.marketId);
                    const resolved = mkt?.status === "Resolved";
                    const didSettle = !!p.redeemed || settledLocal.has(p.marketId);
                    const cost = posCostUsd(p.usdc);
                    let markMid: number | null = null;
                    if (resolved) {
                      if (mkt?.winning_side) markMid = mkt.winning_side === p.side ? 100 : 0;
                    } else {
                      const yesMid =
                        (p.marketId === mid ? yesMidCents(book) : null) ??
                        posMids[p.marketId] ??
                        (typeof lastYes[p.marketId] === "number" ? lastYes[p.marketId] : null) ??
                        null;
                      markMid = sideMidFromYes(yesMid, p.side);
                    }
                    const value = posValueUsd(p.shares, markMid);
                    const pnl = value == null ? null : value - cost;
                    const expLeft = resolved ? "—" : fmtExpLeft(mkt?.expires_at, nowSec);
                    return (
                      <tr key={`${p.marketId}-${p.side}`} onClick={() => openMarket(p.marketId)} style={{ cursor: "pointer" }}>
                        <td className="left">
                          <MarketTitlePills
                            market={mkt}
                            marketId={p.marketId}
                            spotUsd={pxToUsd(spotRaw)}
                            nowSec={nowSec}
                            priceDp={priceDpFor(cfg, marketAsset(mkt || { id: p.marketId }))}
                          />
                        </td>
                        <td className={p.side === "Yes" ? "yes al" : "no al"}>{p.side.toUpperCase()}</td>
                        <td>{fmtShares(p.shares)}</td>
                        <td>{posEntry(p.usdc, p.shares)}</td>
                        <td>{markMid == null ? "—" : `${markMid.toFixed(2)}¢`}</td>
                        <td>{fmtUsdc(p.usdc)}</td>
                        <td>{fmtUsdPlain(value)}</td>
                        <td className={pnl == null ? "" : pnl < 0 ? "no" : pnl > 0 ? "yes" : ""}>
                          {pnl == null ? "—" : fmtSignedUsdNum(pnl)}
                        </td>
                        <td className="sha">{expLeft}</td>
                        <td>
                          {resolved ? (
                            didSettle ? (
                              <span className="sha">Redeemed</span>
                            ) : (
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  redeem(p.marketId);
                                }}
                              >
                                Redeem
                              </button>
                            )
                          ) : (
                            <>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  closePos(p);
                                }}
                              >
                                close
                              </button>
                              {positions.some((q) => q.marketId === p.marketId && q.side !== p.side && Number(q.shares) > 0) && (
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    mergePos(p.marketId);
                                  }}
                                >
                                  merge
                                </button>
                              )}
                            </>
                          )}
                        </td>
                      </tr>
                    );
                  });
                })()}
              </tbody>
            </table>
          )}
          </div>
        </div>
      </div>
      <nav className="mobile-tab-bar" aria-label="Mobile panels">
        {(
          [
            ["trade", "Trade"],
            ["chart", "Chart"],
            ["book", "Book"],
            ["account", "Account"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            className={mobileTab === id ? "active" : undefined}
            aria-current={mobileTab === id ? "page" : undefined}
            onClick={() => setMobileTab(id)}
          >
            {label}
          </button>
        ))}
      </nav>
    </>
  );
}

type MineBookLevel = { size: number; orderIds: number[] };

/** Resting size of the connected wallet, in the price shown on this book (asks are 100 − the other side). */
function userBookLevels(
  orders: LedgerOrder[],
  market: string,
  view: Side
): { bids: Map<number, MineBookLevel>; asks: Map<number, MineBookLevel> } {
  const bids = new Map<number, MineBookLevel>();
  const asks = new Map<number, MineBookLevel>();
  for (const o of orders) {
    if (o.market_id !== market) continue;
    if (!isOpenOrderStatus(o.status)) continue;
    const rem = Number(o.remaining);
    if (!(rem > 0)) continue;
    const bucket = o.side === view ? bids : asks;
    const px = Number(o.side === view ? o.price : 1000 - o.price);
    if (!Number.isFinite(px)) continue;
    const cur = bucket.get(px) || { size: 0, orderIds: [] };
    cur.size += rem;
    cur.orderIds.push(o.id);
    bucket.set(px, cur);
  }
  return { bids, asks };
}

/** Asks above bids: asks high→low (best ask at bottom), bids high→low (best bid at top). */
function BookLadder({
  asks,
  bids,
  mineAsks,
  mineBids,
  onPick,
  onCancelMine,
}: {
  asks: BookLevel[];
  bids: BookLevel[];
  mineAsks?: Map<number, MineBookLevel>;
  mineBids?: Map<number, MineBookLevel>;
  /** Price in cents; cumShares = shares from best through the clicked level. */
  onPick: (price: number, cumShares: number) => void;
  /** Cancel resting orders at a mine price level. */
  onCancelMine?: (orderIds: number[]) => void;
}) {
  const askScrollRef = useRef<HTMLDivElement>(null);

  // Best-first: cumulate from the spread outward so the far end of each side is 100%.
  function withCum(levels: BookLevel[]) {
    let cumUsd = 0;
    let cumShares = 0;
    return levels.map(([p, sz]) => {
      const shares = Number(sz);
      const n = Number.isFinite(shares) && shares > 0 ? shares : 0;
      const level = levelUsd(p, sz);
      cumUsd += level;
      cumShares += n;
      return { p, sz, level, cum: cumUsd, cumShares };
    });
  }
  const askBestFirst = withCum(asks);
  const bidBestFirst = withCum(bids);
  const askTotal = askBestFirst.length ? askBestFirst[askBestFirst.length - 1].cum : 0;
  const bidTotal = bidBestFirst.length ? bidBestFirst[bidBestFirst.length - 1].cum : 0;
  // Asks: show high→low (best/lowest at bottom) → reverse after cum from best.
  const askDisplay = [...askBestFirst].reverse();
  const bidDisplay = bidBestFirst;
  const bestAsk = asks[0]?.[0];
  const bestBid = bids[0]?.[0];
  const spread =
    bestAsk != null && bestBid != null && Number.isFinite(bestAsk) && Number.isFinite(bestBid)
      ? (bestAsk - bestBid) / 10
      : null;

  // Keep best asks pinned to the spread when the ask side updates.
  useEffect(() => {
    const el = askScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [askDisplay.length, askTotal]);

  function row(
    kind: "bid" | "ask",
    r: { p: number; sz: number | string; level: number; cum: number; cumShares: number },
    sideTotal: number,
    mine?: Map<number, MineBookLevel>
  ) {
    const yours = mine?.get(Number(r.p));
    const yoursSize = yours?.size || 0;
    const depthPct = sideTotal > 0 ? Math.min(100, (r.cum / sideTotal) * 100) : 0;
    return (
      <tr
        key={`${kind}-${r.p}`}
        className={yoursSize > 0 ? `${kind} mine` : kind}
        style={{ ["--depth" as string]: `${depthPct}%` }}
        title={yoursSize > 0 ? `your order · ${fmtShares(yoursSize, 1)}` : undefined}
        onClick={() => {
          if (r.p) onPick(decicentsToCents(r.p), r.cumShares);
        }}
      >
        <td className={kind === "bid" ? "yes" : "no"}>
          {yoursSize > 0 && yours ? (
            <button
              type="button"
              className="book-mine-x"
              title="Cancel order"
              aria-label="Cancel order"
              onClick={(e) => {
                e.stopPropagation();
                onCancelMine?.(yours.orderIds);
              }}
            >
              ×
            </button>
          ) : null}
          {fmtPriceDecicents(r.p)}
        </td>
        <td>{fmtShares(r.sz, 1)}</td>
        <td>{fmtUsd(r.level)}</td>
      </tr>
    );
  }

  function sideTable(
    kind: "bid" | "ask",
    rows: { p: number; sz: number | string; level: number; cum: number; cumShares: number }[],
    sideTotal: number,
    mine?: Map<number, MineBookLevel>
  ) {
    return (
      <table>
        <colgroup>
          <col className="col-px" />
          <col className="col-sz" />
          <col className="col-usd" />
        </colgroup>
        <tbody>
          {rows.length === 0 ? (
            <tr className="empty">
              <td className="left" colSpan={3}>
                —
              </td>
            </tr>
          ) : (
            rows.map((r) => row(kind, r, sideTotal, mine))
          )}
        </tbody>
      </table>
    );
  }

  return (
    <div className="book-ladder">
      <table className="book-head-row">
        <colgroup>
          <col className="col-px" />
          <col className="col-sz" />
          <col className="col-usd" />
        </colgroup>
        <thead>
          <tr>
            <th>price</th>
            <th>size</th>
            <th>USD</th>
          </tr>
        </thead>
      </table>
      <div className="book-scroll asks" ref={askScrollRef}>
        {sideTable("ask", askDisplay, askTotal, mineAsks)}
      </div>
      <div className="book-spread">
        {spread == null ? "—" : `spread ${spread}¢`}
      </div>
      <div className="book-scroll bids">
        {sideTable("bid", bidDisplay, bidTotal, mineBids)}
      </div>
    </div>
  );
}

function chartPointer(
  e: { clientX: number; clientY: number },
  el: HTMLDivElement,
  w: number,
  h: number,
  pad: number
): { vx: number; vy: number } | null {
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return null;
  const vx = ((e.clientX - r.left) / r.width) * w;
  const vy = ((e.clientY - r.top) / r.height) * h;
  if (vx < pad || vx > w - pad || vy < pad || vy > h - pad) return null;
  return { vx, vy };
}

function tsFromX(vx: number, start: number, spanT: number, w: number, pad: number): number {
  return start + ((vx - pad) / (w - 2 * pad)) * spanT;
}

function priceFromY(vy: number, lo: number, spanY: number, h: number, pad: number): number {
  return lo + (1 - (vy - pad) / (h - 2 * pad)) * spanY;
}

function ChartCrosshair({
  w,
  h,
  vx,
  vy,
  label,
}: {
  w: number;
  h: number;
  vx: number;
  vy: number;
  label: string;
}) {
  const flip = vx > w * 0.62;
  return (
    <>
      <svg className="crosshair" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
        <line x1={vx} x2={vx} y1={0} y2={h} stroke="#8a969e" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        <line x1={0} x2={w} y1={vy} y2={vy} stroke="#8a969e" strokeWidth="1" vectorEffect="non-scaling-stroke" />
      </svg>
      <div
        className={`cross-readout${flip ? " flip" : ""}`}
        style={{ left: `${(vx / w) * 100}%`, top: `${(vy / h) * 100}%` }}
      >
        {label}
      </div>
    </>
  );
}

const MidChart = memo(function MidChart({
  points,
  startTs,
  endTs,
  nowTs,
  color,
  orderLines = [],
}: {
  points: { t: number; p: number }[];
  startTs: number;
  endTs: number;
  nowTs: number;
  color: string;
  orderLines?: { price: number; side: Side; rem: number }[];
}) {
  const w = 320;
  const h = 120;
  const pad = 8;
  const end = Math.max(endTs || nowTs, (startTs || nowTs) + 1);
  const start = startTs || end - 1;
  const sorted = [...points].filter((p) => p.t >= start && p.t <= end).sort((a, b) => a.t - b.t);
  const last = sorted[sorted.length - 1];
  const liveEnd = Math.min(nowTs, end);
  // Hold the live tip through the right edge of the current minute.
  const drawn = last && last.t < liveEnd ? [...sorted, { t: liveEnd, p: last.p }] : sorted;
  const spanT = Math.max(1, end - start);
  const x = (ts: number) => pad + ((ts - start) / spanT) * (w - 2 * pad);
  let lo = 0;
  let hi = 100;
  if (drawn.length > 0 || orderLines.length > 0) {
    let rawLo = drawn.length > 0 ? drawn[0].p : orderLines[0].price;
    let rawHi = rawLo;
    for (const pt of drawn) {
      if (pt.p < rawLo) rawLo = pt.p;
      if (pt.p > rawHi) rawHi = pt.p;
    }
    for (const o of orderLines) {
      if (o.price < rawLo) rawLo = o.price;
      if (o.price > rawHi) rawHi = o.price;
    }
    lo = Math.floor(rawLo / 10) * 10;
    hi = Math.ceil(rawHi / 10) * 10;
  }
  if (hi <= lo) hi = lo + 10;
  const spanY = hi - lo;
  const y = (p: number) => pad + (1 - (p - lo) / spanY) * (h - 2 * pad);
  const d =
    drawn.length > 0
      ? drawn.map((pt, i) => `${i === 0 ? "M" : "L"}${x(pt.t).toFixed(1)},${y(pt.p).toFixed(1)}`).join(" ")
      : "";
  const lastPx = last?.p ?? null;
  const yLast = lastPx == null ? null : y(lastPx);
  const priceSteps: number[] = [];
  for (let p = lo; p <= hi + 1e-9; p += 10) priceSteps.push(p);
  const timeTicks = chartTimeTicks(start, end);
  const plotRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ vx: number; vy: number } | null>(null);
  const hoverLabel = hover
    ? `${fmtChartTick(tsFromX(hover.vx, start, spanT, w, pad), spanT)}  ${priceFromY(hover.vy, lo, spanY, h, pad).toFixed(1)}¢`
    : "";
  const visibleOrders = orderLines.filter((o) => o.price >= lo && o.price <= hi);
  return (
    <div className="chart-body">
      <div className="chart-plot">
        <div
          className="chart-svg"
          ref={plotRef}
          onMouseMove={(e) => setHover(plotRef.current ? chartPointer(e, plotRef.current, w, h, pad) : null)}
          onMouseLeave={() => setHover(null)}
        >
        <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
          {(drawn.length > 0 || visibleOrders.length > 0) &&
            priceSteps.map((p) => {
              const yy = y(p);
              return (
                <line
                  key={`g${p}`}
                  x1={0}
                  x2={w}
                  y1={yy}
                  y2={yy}
                  stroke="#3a4450"
                  strokeWidth="1"
                  strokeDasharray="2 4"
                  vectorEffect="non-scaling-stroke"
                  opacity="0.45"
                />
              );
            })}
          {visibleOrders.map((o) => {
            const yy = y(o.price);
            const stroke = o.side === "Yes" ? "#3dba7a" : "#e06a5c";
            return (
              <line
                key={`ord-${o.side}-${o.price}`}
                className="chart-order-line"
                x1={0}
                x2={w}
                y1={yy}
                y2={yy}
                stroke={stroke}
                strokeWidth="1.25"
                strokeDasharray="6 3"
                vectorEffect="non-scaling-stroke"
                opacity="0.85"
              >
                <title>{`${o.side} order · ${fmtCents(o.price)}¢ · ${fmtShares(o.rem, 1)}`}</title>
              </line>
            );
          })}
          {yLast != null && (
            <line
              x1={0}
              x2={w}
              y1={yLast}
              y2={yLast}
              stroke={color}
              strokeWidth="1"
              strokeDasharray="3 3"
              vectorEffect="non-scaling-stroke"
              opacity="0.7"
            />
          )}
          {d && (
            <path
              d={d}
              fill="none"
              stroke={color}
              strokeWidth="1.75"
              vectorEffect="non-scaling-stroke"
            />
          )}
          {drawn.length === 1 && (
            <circle cx={x(drawn[0].t)} cy={y(drawn[0].p)} r="2.5" fill={color} />
          )}
        </svg>
        {hover && <ChartCrosshair w={w} h={h} vx={hover.vx} vy={hover.vy} label={hoverLabel} />}
        </div>
        <div className="chart-yaxis">
          {(drawn.length > 0 || visibleOrders.length > 0) &&
            priceSteps.map((p) => (
              <div key={`y${p}`} className="tick" style={{ top: `${(y(p) / h) * 100}%` }}>
                {fmtCents(p)}¢
              </div>
            ))}
          {visibleOrders.map((o) => {
            const stroke = o.side === "Yes" ? "#3dba7a" : "#e06a5c";
            return (
              <div
                key={`oy-${o.side}-${o.price}`}
                className={`tick order ${o.side === "Yes" ? "yes" : "no"}`}
                style={{ top: `${(y(o.price) / h) * 100}%`, color: stroke }}
                title={`${o.side} · ${fmtShares(o.rem, 1)}`}
              >
                <span className="lbl" style={{ color: stroke }}>
                  ord
                </span>
                {fmtCents(o.price)}¢
              </div>
            );
          })}
          {yLast != null && lastPx != null && (
            <div className="tick mid" style={{ top: `${(yLast / h) * 100}%`, color }}>
              <span className="lbl" style={{ color }}>mid</span>
              {fmtCents(lastPx)}¢
            </div>
          )}
        </div>
      </div>
      <div className="chart-axis">
        <div className="chart-xaxis">
          {drawn.length === 0 ? (
            <span className="waiting">waiting for book mid…</span>
          ) : (
            timeTicks.map((t, i) => {
              const left = ((t - start) / spanT) * 100;
              const edge = i === 0 ? "start" : i === timeTicks.length - 1 ? "end" : "";
              return (
                <span
                  key={`t${t}-${i}`}
                  className={`xtick${edge ? ` ${edge}` : ""}`}
                  style={{ left: `${left}%` }}
                >
                  {fmtChartTick(t, spanT)}
                </span>
              );
            })
          )}
        </div>
        <div className="chart-axis-spacer" aria-hidden />
      </div>
    </div>
  );
});
