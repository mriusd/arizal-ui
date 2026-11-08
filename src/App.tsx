import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  useAccount,
  useConnect,
  useDisconnect,
  usePublicClient,
  useSwitchChain,
  useWriteContract,
} from "wagmi";
import { formatEther, formatUnits, parseUnits, zeroAddress, type Address, type Hex } from "viem";
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
  Side,
  SignedOrder,
  Tif,
} from "./api/types";
import { cancelAllMarketId, cancelAllTypes, cancelTypes, domain, marketIdHash, orderMessage, orderTypes } from "./eip712";
import { exchangeAbi, usdcAbi } from "./abi";
import { clearTradingAccount, createTradingAccount, loadTradingAccount } from "./tradingKey";
import { config, localChain } from "./wagmi";

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

/** Taker fee in USDC. Matches engine `taker_fee` (price in decicents, factor / 1e18). */
function estimateTakerFeeUsdc(sizeShares: number, priceDecicents: number, factorStr?: string): number {
  if (!(sizeShares > 0) || !(priceDecicents > 0) || priceDecicents >= 1000) return 0;
  let factor = 0n;
  try {
    factor = BigInt(factorStr || "0");
  } catch {
    return 0;
  }
  if (factor <= 0n) return 0;
  const sizeRaw = BigInt(Math.round(sizeShares * 1_000_000));
  const curve = BigInt(Math.round(priceDecicents)) * BigInt(1000 - Math.round(priceDecicents));
  const feeRaw = (sizeRaw * factor * curve) / (10n ** 18n * 1_000_000n);
  return Number(feeRaw) / 1_000_000;
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
  hit: "#6a8fad",
  above: "#9a7bb8",
  between: "#4a9e8e",
};

const TIMEFRAME_PILL_COLOR: Record<string, string> = {
  daily: "#c4a35a",
  weekly: "#b8894a",
  monthly: "#a87878",
  quarterly: "#7a8aad",
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

function fmtExpiryPill(expiresAt: number | undefined, timeframe?: string): string {
  if (!expiresAt || expiresAt <= 0) return "—";
  const d = new Date(expiresAt * 1000);
  if (timeframe === "quarterly") {
    return d.toLocaleDateString(undefined, { month: "short", year: "2-digit" });
  }
  // daily / weekly / monthly — day + month (e.g. 10 Nov)
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
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
  const level = strikeUsd(market);
  let color = "#8a969e";
  if (spotUsd != null && level != null) {
    color = spotUsd >= level ? "#3dba7a" : "#e06a5c";
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
  if (left < 24 * 3600) return "#e06a5c";
  if (left < 72 * 3600) return "#d4a017";
  return "#3dba7a";
}

function ExpiryPill({
  market,
  marketId,
  expiresAt,
  nowSec,
}: {
  market?: Market | null;
  marketId?: string;
  expiresAt?: number;
  nowSec?: number;
}) {
  const ts = expiresAt ?? market?.expires_at;
  const now = nowSec ?? Math.floor(Date.now() / 1000);
  const expiry = fmtExpiryPill(ts, market?.timeframe);
  return (
    <span className="mkt-pill" style={pillStyle(expiryPillColor(ts, now))} title={marketId}>
      {expiry}
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

  // Top-of-book rides the markets list/WS (memory on the node) — no per-cell /book polls.
  const quotes = useMemo(() => {
    const next: Record<string, TopQuote> = {};
    for (const m of live) {
      next[m.id] = {
        bid: typeof m.best_yes_bid === "number" ? m.best_yes_bid : null,
        ask: typeof m.best_yes_ask === "number" ? m.best_yes_ask : null,
      };
    }
    return next;
  }, [live]);
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
        <div className="tabs">
          {(["hit", "above", "between"] as const).map((k) => (
            <button key={k} className={kind === k ? "active" : ""} onClick={() => onMarketsTab(k)}>
              {k === "hit" ? "Hit" : k === "above" ? "Above" : "Between"}
            </button>
          ))}
          <span className="tab-sep" aria-hidden="true" />
          {(["daily", "weekly", "monthly", "quarterly"] as const).map((t) => (
            <button key={t} className={marketsTf === t ? "active" : ""} onClick={() => onMarketsTf(t)}>
              {t === "daily" ? "Daily" : t === "weekly" ? "Weekly" : t === "monthly" ? "Monthly" : "Quarterly"}
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
            <span className="mono">{fmtCountdown(market?.expires_at, nowSec)}</span>
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

type MineTab = "positions" | "closed" | "orders" | "trades" | "funds";

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
  tif: Tif;
  expiresAt: number;
};

function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
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
    tif: "GTC",
    expiresAt: 0,
  };
  try {
    const raw = localStorage.getItem(UI_PREFS_KEY);
    if (!raw) return d;
    const v = JSON.parse(raw) as Partial<UiPrefs>;
    const price = Number(v.price);
    const expiresAt = Number(v.expiresAt);
    return {
      mineTab: oneOf(v.mineTab, ["positions", "closed", "orders", "trades", "funds"], d.mineTab),
      chartTf: oneOf(v.chartTf, ["5m", "1h", "1d", "30d"], d.chartTf),
      marketsTab: oneOf(v.marketsTab, ["hit", "above", "between"], d.marketsTab),
      marketsTf: oneOf(v.marketsTf, ["daily", "weekly", "monthly", "quarterly"], d.marketsTf),
      side: oneOf(v.side, ["Yes", "No"], d.side),
      intent: oneOf(v.intent, ["buy", "sell"], d.intent),
      entryKind: oneOf(v.entryKind, ["limit", "market", "merge", "split"], d.entryKind),
      price: Number.isInteger(price) && price >= 1 && price <= 99 ? price : d.price,
      size: typeof v.size === "string" && v.size.length > 0 && v.size.length <= 32 ? v.size : d.size,
      tif: oneOf(v.tif, ["GTC", "GTD", "FOK", "FAK"], d.tif),
      expiresAt: Number.isFinite(expiresAt) && expiresAt >= 0 ? expiresAt : d.expiresAt,
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

function marketIdFromPath(path: string): string {
  const p = path.replace(/^\/+|\/+$/g, "");
  if (!p || p === "index.html") return "";
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

/** Compact time-to-expiry: `3d` when ≥1d, else `5h`. */
function fmtExpLeft(expiresAt: number | undefined, now: number): string {
  if (!expiresAt || expiresAt <= 0) return "—";
  const s = Math.max(0, expiresAt - now);
  if (s <= 0) return "0h";
  if (s >= 86400) return `${Math.floor(s / 86400)}d`;
  return `${Math.max(1, Math.ceil(s / 3600))}h`;
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
  const { connect, connectors } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChainAsync } = useSwitchChain();
  const publicClient = usePublicClient({ chainId: localChain.id });
  const { writeContractAsync: writeInjected } = useWriteContract();
  const onHardhat = walletChainId === localChain.id;
  /** On-chain authorizeSession wallet matches the browser key and is unexpired. */
  const [tradingEnabled, setTradingEnabled] = useState(false);

  const [cfg, setCfg] = useState<Config | null>(null);
  const [markets, setMarkets] = useState<Market[]>([]);
  const [marketId, setMarketId] = useState<string>(() => marketIdFromPath(window.location.pathname));
  const [book, setBook] = useState<Book | null>(null);
  const [acct, setAcct] = useState<Account | null>(null);
  const [walletUsdc, setWalletUsdc] = useState<bigint>(0n);
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
  /** Closed positions tab — closes + redeems from ledger / WS `closed_positions`. */
  const [closedFills, setClosedFills] = useState<MyFill[]>([]);
  const [dbOrders, setDbOrders] = useState<LedgerOrder[]>([]);
  const [funds, setFunds] = useState<LedgerFund[]>([]);
  const [lastYes, setLastYes] = useState<Record<string, number>>({});
  /** Yes book mid (¢) by market id — for position mark value. */
  const [posMids, setPosMids] = useState<Record<string, number>>({});
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));
  const [spotRaw, setSpotRaw] = useState<string | null>(null);
  const [marketsOpen, setMarketsOpen] = useState(false);
  const [chartTf, setChartTf] = useState(savedUi.chartTf);
  const [marketsTab, setMarketsTab] = useState(savedUi.marketsTab);
  const [marketsTf, setMarketsTf] = useState(savedUi.marketsTf);
  const [side, setSide] = useState(savedUi.side);
  const [intent, setIntent] = useState(savedUi.intent);
  const [entryKind, setEntryKind] = useState(savedUi.entryKind);
  const [price, setPrice] = useState(savedUi.price);
  const [size, setSize] = useState(savedUi.size);
  const [tif, setTif] = useState(savedUi.tif);
  const [expiresAt, setExpiresAt] = useState(savedUi.expiresAt);
  const [dwAmt, setDwAmt] = useState("100");
  const [err, setErr] = useState<string>("");
  const [apiDown, setApiDown] = useState(false);
  const [wsDown, setWsDown] = useState(false);
  const [msg, setMsg] = useState("");
  const didInitFollow = useRef(false);

  useEffect(() => {
    const prefs: UiPrefs = { mineTab, chartTf, marketsTab, marketsTf, side, intent, entryKind, price, size, tif, expiresAt };
    try {
      localStorage.setItem(UI_PREFS_KEY, JSON.stringify(prefs));
    } catch {
      /* private mode */
    }
  }, [mineTab, chartTf, marketsTab, marketsTf, side, intent, entryKind, price, size, tif, expiresAt]);
  const midRef = useRef("");
  const marketIdRef = useRef(marketId);
  const traderRef = useRef(trader);
  const acctFundTxRef = useRef(new Set<string>());
  const wsRef = useRef<WebSocket | null>(null);

  const marketsRef = useRef<Market[]>([]);
  marketsRef.current = markets;
  const market = markets.find((m) => m.id === marketId) || markets.find((m) => m.status === "Open") || markets[0];
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
  const bookSeqRef = useRef(-1);

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

  const applyMarkets = useCallback(
    (ms: Market[]) => {
      if (ms.length === 0) return;
      setMarkets(ms);
      const fromUrl = marketIdFromPath(window.location.pathname);
      const want = fromUrl || marketIdRef.current;
      const liveOpen = ms.find((x) => x.status === "Open");
      const m = ms.find((x) => x.id === want) || (!want ? liveOpen || ms[0] : undefined);
      if (!didInitFollow.current) didInitFollow.current = true;
      const nextId = !m && liveOpen ? liveOpen.id : fromUrl && fromUrl !== marketIdRef.current ? fromUrl : m && !fromUrl ? m.id : null;
      if (nextId && nextId !== marketIdRef.current) {
        if (fromUrl && fromUrl === nextId) setMarketId(fromUrl);
        else openMarket(nextId, "replace");
      }
    },
    [openMarket]
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

  const applyClosedSnapshot = useCallback(
    (closedTrades: LedgerTrade[]) => {
      setClosedFills(mapLedgerTrades(closedTrades, marketsRef.current));
    },
    [mapLedgerTrades]
  );

  const applyLedgerSnapshot = useCallback(
    (poss: LedgerPos[], ledgerTrades: LedgerTrade[], closedTrades?: LedgerTrade[]) => {
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
      if (closedTrades) {
        setClosedFills(mapLedgerTrades(closedTrades, ms));
      } else {
        // Fallback until node sends `closed`: seller closes + redeems from trades.
        setClosedFills(
          mapLedgerTrades(
            ledgerTrades.filter((t) => !!t.closing || t.op === "settle"),
            ms
          )
        );
      }
    },
    [mapLedgerTrades]
  );

  /** Wallet ledger only. Account is fetched separately and sparsely — it hits chain RPC. */
  const refresh = useCallback(async () => {
    try {
      setApiDown(false);
      if (!trader) {
        setDbOrders([]);
        setPositions([]);
        setMyFills([]);
        setClosedFills([]);
        setFunds([]);
        return;
      }
      const [orders, ledgerTrades, poss, closed, cash] = await Promise.all([
        api.ledgerOrders(trader).catch(() => []),
        api.ledgerTrades(trader).catch(() => []),
        api.ledgerPositions(trader).catch(() => []),
        api.ledgerClosed(trader).catch(() => [] as LedgerTrade[]),
        api.ledgerFunds(trader).catch(() => []),
      ]);
      setFunds(cash);
      setDbOrders(orders);
      applyLedgerSnapshot(poss, ledgerTrades, closed);
    } catch (e: unknown) {
      const msg = String(e);
      if (e instanceof TypeError || /failed to fetch|networkerror|load failed/i.test(msg)) {
        setApiDown(true);
      } else {
        setErr(msg);
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

  useEffect(() => {
    const id = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);

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
              const live = yesMidCents(book);
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
    const t = setInterval(load, 2000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [posMarketIds, book]);

  // Wallet ledger when trader changes; not on a timer.
  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    const onPop = () => setMarketId(marketIdFromPath(window.location.pathname));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

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

  useEffect(() => {
    void refreshTradingEnabled();
    // refreshTradingEnabled closes over latest cfg/trader/publicClient
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
          tx_hash?: string;
          positions?: LedgerPos[];
          trades?: LedgerTrade[];
          closed?: LedgerTrade[];
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
          setMarkets((ms) =>
            ms.map((m) =>
              m.id === msgMarketId
                ? {
                    ...m,
                    best_yes_bid: Number.isFinite(bid as number) ? (bid as number) : null,
                    best_yes_ask: Number.isFinite(ask as number) ? (ask as number) : null,
                  }
                : m
            )
          );
          return;
        }
        if (v.channel === "price") {
          const raw = v.spot || (typeof v.price === "string" || typeof v.price === "number" ? String(v.price) : null);
          if (raw) setSpotRaw(raw);
          return;
        }
        if (v.channel === "last_yes" && msgMarketId && v.price != null) {
          const px = typeof v.price === "number" ? v.price : Number(v.price);
          if (!(px > 0) || px >= 100) return;
          setMarkets((ms) => ms.map((m) => (m.id === msgMarketId ? { ...m, last_yes_price: px } : m)));
          setLastYes((m) => ({ ...m, [msgMarketId]: px }));
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
          const em = tapeMarketId(e);
          if (em && em !== id) return;
          if (e.kind === "FillCommitted" && e.fill_id != null && e.tx_hash) {
            const fid = e.fill_id;
            const hash = e.tx_hash;
            setFillTx((m) => (m[fid] === hash ? m : { ...m, [fid]: hash }));
          }
        } else if (v.channel === "trades" && v.fill) {
          const f = v.fill;
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
          if (f.confirmed && (f.tx_hash || "").startsWith("0x")) {
            setMyFills((rows) =>
              rows.map((r) =>
                r.status === "pending" &&
                (r.id === f.fill_id ||
                  (r.marketId === f.market_id &&
                    Math.abs((r.ts || 0) - f.ts_engine) <= 2 &&
                    Math.abs(Number(r.shares) - Number(f.size)) < 1e-9))
                  ? { ...r, status: "confirmed", txHash: f.tx_hash }
                  : r
              )
            );
          }
        } else if (v.channel === "ledger" && v.trader && Array.isArray(v.positions) && Array.isArray(v.trades)) {
          const me = traderRef.current?.toLowerCase();
          if (!me || String(v.trader).toLowerCase() !== me) return;
          const closed = Array.isArray(v.closed) ? (v.closed as LedgerTrade[]) : undefined;
          applyLedgerSnapshot(v.positions, v.trades, closed);
        } else if (v.channel === "closed_positions" && v.trader && Array.isArray(v.closed)) {
          const me = traderRef.current?.toLowerCase();
          if (!me || String(v.trader).toLowerCase() !== me) return;
          applyClosedSnapshot(v.closed as LedgerTrade[]);
        } else if (v.channel === "orders" && v.trader && Array.isArray(v.orders)) {
          const me = traderRef.current?.toLowerCase();
          if (!me || String(v.trader).toLowerCase() !== me) return;
          setDbOrders(v.orders);
        } else if (v.channel === "account" && v.trader && v.amount != null) {
          const me = traderRef.current?.toLowerCase();
          if (!me || String(v.trader).toLowerCase() !== me) return;
          const tx = String(v.tx_hash || "").toLowerCase();
          if (tx) {
            if (acctFundTxRef.current.has(tx)) return;
            acctFundTxRef.current.add(tx);
          }
          const amt = Number(v.amount);
          if (!Number.isFinite(amt) || amt <= 0) return;
          const op = String(v.op || "deposit");
          const delta = op === "withdraw" ? -amt : amt;
          setAcct((a) => {
            if (!a) return a;
            const coll = Math.max(0, Number(a.collateral) + delta);
            const avail = Math.max(0, Number(a.available) + delta);
            return { ...a, collateral: coll, available: avail };
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
      wsRef.current = null;
      sock?.close();
    };
  }, [applyBook, applyMarkets, upsertMarket, applyLedgerSnapshot, applyClosedSnapshot]);

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

  useEffect(() => {
    if (!publicClient || !cfg || !trader) return;
    publicClient.readContract({ address: cfg.usdc, abi: usdcAbi, functionName: "balanceOf", args: [trader] }).then(setWalletUsdc);
  }, [publicClient, cfg, trader, acct]);

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

  /** EIP-712 Order: prefer the authorized wallet when Enable Trading is active. */
  async function signOrder(message: Record<string, unknown>): Promise<Hex> {
    if (!cfg || !trader) throw new Error("wallet/rpc not ready");
    const wallet = loadTradingAccount(trader as Address);
    if (tradingEnabled && wallet) {
      const dom = domain(cfg.chain_id, cfg.exchange);
      return wallet.signTypedData({
        domain: dom,
        types: orderTypes,
        primaryType: "Order",
        message: message as never,
      });
    }
    return signAsUser(orderTypes, "Order", message);
  }

  async function refreshTradingEnabled() {
    if (!publicClient || !cfg || !trader) {
      setTradingEnabled(false);
      return;
    }
    const wallet = loadTradingAccount(trader as Address);
    if (!wallet) {
      setTradingEnabled(false);
      return;
    }
    try {
      const [onChain, expiresAt] = await Promise.all([
        publicClient.readContract({
          address: cfg.exchange,
          abi: exchangeAbi,
          functionName: "authorizedWallet",
          args: [trader as Address],
        }) as Promise<Address>,
        publicClient.readContract({
          address: cfg.exchange,
          abi: exchangeAbi,
          functionName: "authorizedWalletExpires",
          args: [trader as Address],
        }) as Promise<bigint>,
      ]);
      const now = BigInt(Math.floor(Date.now() / 1000));
      setTradingEnabled(
        onChain.toLowerCase() === wallet.address.toLowerCase() && expiresAt > now,
      );
    } catch {
      setTradingEnabled(false);
    }
  }

  async function enableTrading() {
    if (!cfg || !trader) return;
    setErr("");
    try {
      await ensureHardhat();
      let wallet = loadTradingAccount(trader as Address);
      if (!wallet) wallet = createTradingAccount(trader as Address);
      const expiresAt = BigInt(Math.floor(Date.now() / 1000) + 24 * 60 * 60);
      await writeAsUser({
        chainId: localChain.id,
        address: cfg.exchange,
        abi: exchangeAbi,
        functionName: "authorizeSession",
        args: [wallet.address, expiresAt],
        nonce: await latestNonce(),
      });
      setTradingEnabled(true);
      setMsg(`trading enabled · 24h · ${wallet.address.slice(0, 6)}…${wallet.address.slice(-4)}`);
    } catch (e: unknown) {
      setErr(explainErr(e));
    }
  }

  async function disableTrading() {
    if (!cfg || !trader) return;
    setErr("");
    try {
      await ensureHardhat();
      await writeAsUser({
        chainId: localChain.id,
        address: cfg.exchange,
        abi: exchangeAbi,
        functionName: "authorizeSession",
        args: [zeroAddress, 0n],
        nonce: await latestNonce(),
      });
      clearTradingAccount(trader as Address);
      setTradingEnabled(false);
      setMsg("trading disabled");
    } catch (e: unknown) {
      setErr(explainErr(e));
    }
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
    if (/insufficient collateral/i.test(s)) {
      return "insufficient collateral — orders spend USDC deposited in the exchange, not the wallet balance. Faucet 1000, then deposit.";
    }
    return s;
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
    setErr("");
    try {
      const r = await api.faucet(trader);
      setMsg(`faucet 10 ETH + 1000 USDC → wallet · eth ${shortTx(r.eth_tx_hash)} · usdc ${shortTx(r.usdc_tx_hash)}`);
      refresh();
    } catch (e: unknown) {
      setErr(explainErr(e));
    }
  }

  async function deposit() {
    if (!cfg) return;
    setErr("");
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
      setMsg("deposited");
      refresh();
    } catch (e: unknown) {
      setErr(explainErr(e));
    }
  }

  async function withdraw() {
    if (!cfg) return;
    setErr("");
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
      setMsg("withdrawn");
      refresh();
    } catch (e: unknown) {
      setErr(explainErr(e));
    }
  }

  async function redeem(marketId?: string) {
    const id = marketId || mid;
    if (!cfg || !id) return;
    setErr("");
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
      setMsg("redeemed");
      refresh();
    } catch (e: unknown) {
      setErr(explainErr(e));
    }
  }

  async function submitOrder(opts: {
    marketId: string;
    side: Side;
    price: number;
    size: string;
    tif: Tif;
    market: boolean;
    close?: boolean;
  }) {
    if (!cfg || !trader) return;
    setErr("");
    const pxCents = opts.market ? (opts.close ? 0 : 99) : opts.price;
    const px = opts.market ? (opts.close ? 0 : MAX_DECICENTS) : centsToDecicents(opts.price);
    const useTif: Tif = opts.market ? "FAK" : opts.tif;
    try {
      await ensureHardhat();
      const nowSec = Math.floor(Date.now() / 1000);
      const minGtd = nowSec + (cfg.gtd_min_secs ?? 60);
      if (useTif === "GTD" && expiresAt < minGtd) {
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
      const have = (acct?.collateral ?? 0) - sideReserved;
      if (!opts.close && acct && have < need) {
        throw new Error(
          `insufficient collateral: need ${(need / 1e6).toFixed(2)} USDC on this market side, have ${(Math.max(0, have) / 1e6).toFixed(2)}`
        );
      }
      const order: SignedOrder = {
        trader,
        market_id: opts.marketId,
        side: opts.side,
        price: px,
        size: opts.size,
        order_type: "Limit",
        tif: useTif,
        nonce: Date.now(),
        salt: Math.floor(Math.random() * 1e12),
        expires_at: useTif === "GTD" ? expiresAt : 0,
        chain_id: cfg.chain_id,
        verifying_contract: cfg.exchange,
      };
      const signature = await signOrder(orderMessage(order));
      const r = await api.place({ order, signature, close: opts.close || undefined });
      if ((r.fills?.length ?? 0) === 0 && r.reason) {
        const why = r.reason === "fak remainder"
          ? `no ${opts.side.toUpperCase()} bid at or above ${pxCents || "market"}¢`
          : r.reason;
        setErr(`order #${r.order_id} cancelled: ${why}`);
      } else {
        setMsg(`order #${r.order_id} ${r.status}`);
      }
      refresh();
    } catch (e: unknown) {
      setErr(explainErr(e));
    }
  }

  function place() {
    if (!mid) return;
    if (entryKind === "merge") return mergePos(mid, size);
    if (entryKind === "split") return splitPos(mid, size);
    return submitOrder({
      marketId: mid,
      side,
      price,
      size,
      tif,
      market: entryKind === "market",
      close: intent === "sell",
    });
  }

  async function splitPos(marketId: string, sizeStr: string) {
    if (!cfg || !trader) return;
    setErr("");
    try {
      const raw = parseUnits(sizeStr || "0", 6);
      if (raw <= 0n) throw new Error("size required");
      if (acct && BigInt(acct.available) < raw) {
        throw new Error(`insufficient collateral: split needs ${sizeStr} USDC deposited`);
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
      setMsg(`split ${sizeStr} submitted`);
      refresh();
    } catch (e: unknown) {
      setErr(explainErr(e));
    }
  }

  async function mergePos(marketId: string, sizeStr?: string) {
    if (!cfg || !trader) return;
    setErr("");
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
      setMsg(`merge ${n} submitted`);
      refresh();
    } catch (e: unknown) {
      setErr(explainErr(e));
    }
  }

  function closePos(p: MinePos) {
    return submitOrder({
      marketId: p.marketId,
      side: p.side,
      price: 0,
      size: String(p.shares),
      tif: "FAK",
      market: false,
      close: true,
    });
  }

  async function cancel(id: number, marketId: string) {
    if (!cfg || !trader || !marketId) return;
    setErr("");
    try {
      await ensureHardhat();
      const nonce = Date.now();
      const signature = await signAsUser(cancelTypes, "Cancel", {
        trader,
        orderId: BigInt(id),
        marketId,
        nonce: BigInt(nonce),
      });
      await api.cancel(id, { trader, market_id: marketId, nonce, signature });
      refresh();
    } catch (e: unknown) {
      setErr(String(e));
    }
  }

  async function cancelAll() {
    if (!cfg || !trader) return;
    setErr("");
    try {
      await ensureHardhat();
      const nonce = Date.now();
      const signature = await signAsUser(cancelAllTypes, "CancelAll", {
        trader,
        marketId: cancelAllMarketId(),
        nonce: BigInt(nonce),
      });
      const r = await api.cancelAll({ trader, nonce, signature });
      setMsg(`cancelled ${r.count}`);
      refresh();
    } catch (e: unknown) {
      setErr(String(e));
    }
  }

  const history = useMemo(
    () =>
      [...markets].sort((a, b) => {
        const d = barrierKey(b) - barrierKey(a);
        if (d > 0n) return 1;
        if (d < 0n) return -1;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      }),
    [markets]
  );
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
  return (
    <>
      <header>
        <span className="brand">arizal<span>.xyz</span></span>
        <a className="docs" href="/docs.html">docs</a>
        {(apiDown || wsDown) && <span className="conn-down">connection failed, reconnecting</span>}
        <div className="connect">
          {isConnected ? (
            <>
              <span className="sha">{trader?.slice(0, 6)}…{trader?.slice(-4)}</span>{" "}
              {onHardhat ? (
                <span className="ok">{localChain.name} {localChain.id}</span>
              ) : (
                <button className="no" onClick={() => ensureHardhat().catch((e) => setErr(String(e)))}>
                  switch to {localChain.name} (now chain {walletChainId ?? "?"})
                </button>
              )}{" "}
              <button onClick={() => disconnect()}>disconnect</button>
            </>
          ) : (
            connectors.map((c) => (
              <button
                key={c.uid}
                className="primary"
                onClick={() => connect({ connector: c, chainId: localChain.id })}
              >
                connect {c.name}
              </button>
            ))
          )}
        </div>
      </header>
      <MarketPicker
        market={market ?? null}
        quote={bestBidAsk(book)}
        spotRaw={spotRaw}
        nowSec={nowSec}
        open={marketsOpen}
        onToggle={() => setMarketsOpen((o) => !o)}
        rows={history}
        marketsTab={marketsTab}
        onMarketsTab={setMarketsTab}
        marketsTf={marketsTf}
        onMarketsTf={setMarketsTf}
        mine={gridMine}
        priceDp={priceDp}
        onOpen={(id, nextSide) => {
          openMarket(id, "push", nextSide);
          setMarketsOpen(false);
        }}
      />
      <div className="grid">
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
              <span className={`chart-countdown ${countdownTone(market.expires_at, nowSec)}`} title="Time to expiry">
                {fmtCountdown(market.expires_at, nowSec)}
              </span>
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
          />
        </div>

        <div className="panel wallet">
          <h2>Account</h2>
          <div>ETH {acct?.eth_wei ? formatEther(BigInt(acct.eth_wei)) : "—"}</div>
          <div>wallet USDC {formatUnits(walletUsdc, 6)}</div>
          <div>deposited {acct ? formatUnits(BigInt(acct.collateral), 6) : "—"}</div>
          <div>reserved {acct ? formatUnits(BigInt(acct.reserved), 6) : "—"}</div>
          <div>available {acct ? formatUnits(BigInt(acct.available), 6) : "—"}</div>
          <div>
            shares YES <span className="yes">{fmtShares(acct?.yes_shares)}</span> / NO{" "}
            <span className="no">{fmtShares(acct?.no_shares)}</span>
          </div>
          <div className="row">
            <input value={dwAmt} onChange={(e) => setDwAmt(e.target.value)} />
            <button onClick={faucet} disabled={!walletOn}>
              Faucet
            </button>
            <button onClick={deposit}>deposit</button>
            <button onClick={withdraw}>withdraw</button>
          </div>
          {walletOn && (
            <div className="session-auth">
              {tradingEnabled ? (
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
            (positions.some((p) => p.marketId === mid && (p.redeemed || settledLocal.has(p.marketId))) ? (
              <span className="sha">Redeemed</span>
            ) : (
              <button className="primary" onClick={() => redeem()}>
                Redeem {market.winning_side?.toUpperCase()}
              </button>
            ))}
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
            onPick={setPrice}
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
                  <input
                    type="number"
                    min={1}
                    max={99}
                    value={price}
                    onChange={(e) => setPrice(+e.target.value)}
                    onWheel={(e) => e.currentTarget.blur()}
                  />
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
                  <label>tif</label>
                  <select
                    value={tif}
                    onChange={(e) => {
                      const v = e.target.value as Tif;
                      setTif(v);
                      const now = Math.floor(Date.now() / 1000);
                      if (v === "GTD" && expiresAt < now + 60) setExpiresAt(now + 120);
                    }}
                  >
                    <option value="GTC">GTC</option>
                    <option value="GTD">GTD</option>
                    <option value="FOK">FOK</option>
                    <option value="FAK">FAK</option>
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
            {entryKind === "limit" && tif === "GTD" && (
              <div className="row">
                <div className="field">
                  <label>expires unix</label>
                  <input
                    type="number"
                    min={Math.floor(Date.now() / 1000) + 60}
                    value={expiresAt || Math.floor(Date.now() / 1000) + 120}
                    onChange={(e) => setExpiresAt(+e.target.value)}
                    onWheel={(e) => e.currentTarget.blur()}
                  />
                </div>
                <span className="sha">
                  {expiresAt > 0 ? new Date(expiresAt * 1000).toLocaleString() : ""} · ≥ now+60s
                </span>
              </div>
            )}
            <button className={`go ${intent}`} disabled={!walletOn} onClick={place}>
              {entryKind === "merge" || entryKind === "split"
                ? entryKind
                : `${intent === "sell" ? "SELL" : "BUY"} ${side.toUpperCase()}`}
            </button>
            {(() => {
              const n = Number(size) || 0;
              type Row = { label: string; value: string; valueClass?: string };
              const rows: Row[] = [];
              if (entryKind === "market") {
                const levels = intent === "sell" ? depth.bids : depth.asks;
                const vwap = approxVwapDecicents(levels, n);
                const pxCents = vwap != null ? decicentsToCents(vwap) : null;
                const feeUsdc =
                  vwap == null ? null : estimateTakerFeeUsdc(n, vwap, cfg?.trading_fee_factor);
                const notional = pxCents != null && n > 0 ? (n * pxCents) / 100 : null;
                const feePct =
                  feeUsdc != null && notional != null && notional > 0 ? (feeUsdc / notional) * 100 : null;
                if (intent === "buy" && notional != null) {
                  const profit = n - notional;
                  const pct = notional > 0 ? (profit / notional) * 100 : 0;
                  rows.push({ label: "cost", value: `${notional.toFixed(2)} USDC` });
                  rows.push({
                    label: "profit",
                    value: `${profit.toFixed(2)} USDC (${pct.toFixed(0)}%)`,
                    valueClass: "payout",
                  });
                } else if (intent === "sell") {
                  rows.push({
                    label: "proceeds",
                    value: notional != null ? `≈ ${notional.toFixed(2)} USDC` : "into bids",
                  });
                }
                rows.push({
                  label: "≈ exec",
                  value: vwap == null ? "—" : `${fmtPriceDecicents(Math.round(vwap))}¢`,
                });
                rows.push({ label: "fee %", value: feePct == null ? "—" : `${feePct.toFixed(2)}%` });
                rows.push({
                  label: "fee",
                  value: feeUsdc == null ? "—" : `${fmtUsdNum(feeUsdc)} USDC`,
                });
              } else if (entryKind === "split") {
                rows.push({ label: "locks", value: `${n.toFixed(2)} USDC → YES + NO @ 50¢` });
              } else if (entryKind === "merge") {
                rows.push({ label: "returns", value: `≈ ${n.toFixed(2)} USDC` });
              } else if (intent === "sell") {
                rows.push({ label: "sell", value: `${n || 0} ${side.toUpperCase()} ≥ ${price}¢` });
              } else {
                const cost = (n * price) / 100;
                const profit = n - cost;
                const pct = cost > 0 ? (profit / cost) * 100 : 0;
                rows.push({ label: "cost", value: `${cost.toFixed(2)} USDC` });
                rows.push({
                  label: "profit",
                  value: `${profit.toFixed(2)} USDC (${pct.toFixed(0)}%)`,
                  valueClass: "payout",
                });
              }
              if (rows.length === 0) return null;
              return (
                <table className="place-summary">
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.label}>
                        <td className="lbl">{r.label}</td>
                        <td className={`val${r.valueClass ? ` ${r.valueClass}` : ""}`}>{r.value}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              );
            })()}
            {err && <div className="err">{err}</div>}
            {msg && <div className="ok">{msg}</div>}
          </div>
        </div>

        <div className="panel trades">
          <h2>Trades</h2>
          <div className="panel-scroll">
          <table>
            <thead>
              <tr>
                <th className="al">op</th>
                <th className="al">side</th>
                <th>yes</th>
                <th>size</th>
                <th>time</th>
                <th className="al">status</th>
                <th className="left">tx</th>
              </tr>
            </thead>
            <tbody>
              {trades.length === 0 && (
                <tr>
                  <td colSpan={7} className="left">
                    no fills
                  </td>
                </tr>
              )}
              {trades.map((t) => {
                const selling = !!t.close_side;
                const side = t.close_side || t.taker_side;
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
                    <td className={side === "Yes" ? "yes al" : "no al"}>{side.toUpperCase()}</td>
                    <td>{fmtPriceDecicents(t.yes_price)}¢</td>
                    <td>{fmtShares(t.size)}</td>
                    <td>{fmtLocalTime(t.ts_engine)}</td>
                    <td className={confirmed ? "al" : "sha al"}>{confirmed ? "confirmed" : "pending"}</td>
                    <td className="left">{shortTx(hash)}</td>
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
              Open positions
            </button>
            <button className={mineTab === "closed" ? "active" : ""} onClick={() => setMineTab("closed")}>
              Closed positions
            </button>
            <button className={mineTab === "orders" ? "active" : ""} onClick={() => setMineTab("orders")}>
              Orders
            </button>
            <button className={mineTab === "trades" ? "active" : ""} onClick={() => setMineTab("trades")}>
              Trades
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
          ) : mineTab === "trades" ? (
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
                  <th className="al">status</th>
                  <th className="left">tx</th>
                  <th>time</th>
                </tr>
              </thead>
              <tbody>
                {myFills.length === 0 && (
                  <tr>
                    <td colSpan={10} className="left">
                      no trades
                    </td>
                  </tr>
                )}
                {myFills.map((t) => {
                  const pending = t.status === "pending";
                  const pair = t.op === "merge" || t.op === "split";
                  const settle = t.op === "settle";
                  const sell = !pair && !settle && !!t.closing;
                  const op = (settle ? "redeem" : pair ? t.op || "" : sell ? "sell" : "buy").toUpperCase();
                  const unsettled = pending || t.status === "failed";
                  const pnl = unsettled ? null : settle || sell ? (t.pnl ?? 0) / 1e6 : 0;
                  const fee = pair || settle || unsettled || !t.isTaker ? null : (t.fee ?? 0) / 1e6;
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
                      <td className={pair || settle ? "al" : sell ? "no al" : "yes al"}>{op}</td>
                      <td className={pair ? "al" : t.side === "Yes" ? "yes al" : "no al"}>{pair ? "—" : t.side.toUpperCase()}</td>
                      <td>{pair ? "—" : `${t.price}¢`}</td>
                      <td>{fmtShares(t.shares)}</td>
                      <td className={pnl == null ? "" : pnl < 0 ? "no" : pnl > 0 ? "yes" : ""}>
                        {pnl == null ? "—" : fmtSignedUsdNum(pnl)}
                      </td>
                      <td>{fee == null ? "—" : fmtUsdNum(fee)}</td>
                      <td className={pending ? "sha al" : t.status === "failed" ? "no al" : "al"}>
                        {t.status === "pending" ? "pending" : t.status === "failed" ? "failed" : "confirmed"}
                      </td>
                      <td className="left">{shortTx(t.txHash)}</td>
                      <td>{fmtLocalTime(t.ts)}</td>
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
                  <th>st</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {dbOrders.length === 0 && (
                  <tr>
                    <td colSpan={8} className="left">
                      no open orders
                    </td>
                  </tr>
                )}
                {dbOrders.map((o) => (
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
                    <td>{o.price}</td>
                    <td>
                      {fmtShares(o.remaining, 1)}/{fmtShares(o.size, 1)}
                    </td>
                    <td>{o.tif || ""}</td>
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
                ))}
              </tbody>
            </table>
          ) : mineTab === "closed" ? (
            <table>
              <thead>
                <tr>
                  <th className="left">market</th>
                  <th className="al">op</th>
                  <th className="al">side</th>
                  <th>shares</th>
                  <th>exit</th>
                  <th>pnl</th>
                  <th className="al">status</th>
                  <th className="left">tx</th>
                  <th>time</th>
                </tr>
              </thead>
              <tbody>
                {(() => {
                  const rows = closedFills;
                  if (rows.length === 0) {
                    return (
                      <tr>
                        <td colSpan={9} className="left">
                          no closed positions
                        </td>
                      </tr>
                    );
                  }
                  return rows.map((t) => {
                    const pending = t.status === "pending";
                    const redeemOp = t.op === "settle";
                    const op = redeemOp ? "REDEEM" : "CLOSE";
                    const unsettled = pending || t.status === "failed";
                    const pnl = unsettled ? null : (t.pnl ?? 0) / 1e6;
                    return (
                      <tr
                        key={`closed-${t.txHash}-${t.logIndex}-${t.side}-${t.op}-${t.id}`}
                        onClick={() => openMarket(t.marketId)}
                        style={{ cursor: "pointer" }}
                      >
                        <td className="left">
                          <MarketTitlePills
                            market={markets.find((m) => m.id === t.marketId)}
                            marketId={t.marketId}
                            spotUsd={pxToUsd(spotRaw)}
                            nowSec={nowSec}
                            priceDp={priceDpFor(cfg, marketAsset(markets.find((m) => m.id === t.marketId) || { id: t.marketId }))}
                          />
                        </td>
                        <td className="al">{op}</td>
                        <td className={t.side === "Yes" ? "yes al" : "no al"}>{t.side.toUpperCase()}</td>
                        <td>{fmtShares(t.shares)}</td>
                        <td>{redeemOp ? "$1" : `${t.price}¢`}</td>
                        <td className={pnl == null ? "" : pnl < 0 ? "no" : pnl > 0 ? "yes" : ""}>
                          {pnl == null ? "—" : fmtSignedUsdNum(pnl)}
                        </td>
                        <td className={pending ? "sha al" : t.status === "failed" ? "no al" : "al"}>
                          {t.status === "pending" ? "pending" : t.status === "failed" ? "failed" : "confirmed"}
                        </td>
                        <td className="left">{shortTx(t.txHash)}</td>
                        <td>{fmtLocalTime(t.ts)}</td>
                      </tr>
                    );
                  });
                })()}
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
                  <th>cost</th>
                  <th>value</th>
                  <th>pnl</th>
                  <th>Exp</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {(() => {
                  const rows = positions.filter((p) => {
                    return Number(p.shares) > 0;
                  });
                  if (rows.length === 0) {
                    return (
                      <tr>
                        <td colSpan={9} className="left">
                          no open positions
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
    </>
  );
}

/** Resting size of the connected wallet, in the price shown on this book (asks are 100 − the other side). */
function userBookLevels(orders: LedgerOrder[], market: string, view: Side): { bids: Map<number, number>; asks: Map<number, number> } {
  const bids = new Map<number, number>();
  const asks = new Map<number, number>();
  for (const o of orders) {
    if (o.market_id !== market) continue;
    if (!isOpenOrderStatus(o.status)) continue;
    const rem = Number(o.remaining);
    if (!(rem > 0)) continue;
    const bucket = o.side === view ? bids : asks;
    const px = Number(o.side === view ? o.price : 1000 - o.price);
    if (!Number.isFinite(px)) continue;
    bucket.set(px, (bucket.get(px) || 0) + rem);
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
}: {
  asks: BookLevel[];
  bids: BookLevel[];
  mineAsks?: Map<number, number>;
  mineBids?: Map<number, number>;
  onPick: (price: number) => void;
}) {
  const askScrollRef = useRef<HTMLDivElement>(null);

  // Best-first: cumulate USD from the spread outward so the far end of each side is 100%.
  function withCum(levels: BookLevel[]) {
    let cum = 0;
    return levels.map(([p, sz]) => {
      const level = levelUsd(p, sz);
      cum += level;
      return { p, sz, level, cum };
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
    r: { p: number; sz: number | string; level: number; cum: number },
    sideTotal: number,
    mine?: Map<number, number>
  ) {
    const yours = mine?.get(Number(r.p)) || 0;
    const depthPct = sideTotal > 0 ? Math.min(100, (r.cum / sideTotal) * 100) : 0;
    return (
      <tr
        key={`${kind}-${r.p}`}
        className={yours > 0 ? `${kind} mine` : kind}
        style={{ ["--depth" as string]: `${depthPct}%` }}
        title={yours > 0 ? `your order · ${fmtShares(yours, 1)}` : undefined}
        onClick={() => {
          if (r.p) onPick(decicentsToCents(r.p));
        }}
      >
        <td className={kind === "bid" ? "yes" : "no"}>
          {yours > 0 ? "● " : ""}
          {fmtPriceDecicents(r.p)}
        </td>
        <td>{fmtShares(r.sz, 1)}</td>
        <td>{fmtUsd(r.level)}</td>
      </tr>
    );
  }

  function sideTable(
    kind: "bid" | "ask",
    rows: { p: number; sz: number | string; level: number; cum: number }[],
    sideTotal: number,
    mine?: Map<number, number>
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
}: {
  points: { t: number; p: number }[];
  startTs: number;
  endTs: number;
  nowTs: number;
  color: string;
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
  if (drawn.length > 0) {
    let rawLo = drawn[0].p;
    let rawHi = drawn[0].p;
    for (const pt of drawn) {
      if (pt.p < rawLo) rawLo = pt.p;
      if (pt.p > rawHi) rawHi = pt.p;
    }
    lo = Math.floor(rawLo / 10) * 10;
    hi = Math.ceil(rawHi / 10) * 10;
    if (hi <= lo) hi = lo + 10;
  }
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
          {drawn.length > 0 &&
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
          {drawn.length > 0 &&
            priceSteps.map((p) => (
              <div key={`y${p}`} className="tick" style={{ top: `${(y(p) / h) * 100}%` }}>
                {fmtCents(p)}¢
              </div>
            ))}
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
