import type {
  Account,
  LedgerFund,
  LedgerOrder,
  LedgerPos,
  LedgerTrade,
  BatchRequest,
  BatchResult,
  Book,
  Config,
  Fill,
  Holders,
  LivePrice,
  Market,
  MarketChart,
  CancelAll,
  CancelAllResult,
  CancelOrder,
  PlaceOrder,
  ReferralsReport,
  Version,
} from "./types";

const BASE = import.meta.env.VITE_API_URL || "";

async function j<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers || {}) },
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(t || r.statusText);
  }
  return r.json() as Promise<T>;
}

export const api = {
  health: () => fetch(`${BASE}/v1/health`).then((r) => r.text()),
  version: () => j<Version>("/v1/version"),
  config: () => j<Config>("/v1/config"),
  markets: () => j<Market[]>("/v1/markets"),
  market: (id: string) => j<Market>(`/v1/markets/${encodeURIComponent(id)}`),
  book: (id: string) => j<Book>(`/v1/markets/${encodeURIComponent(id)}/book`),
  tape: (id: string, cursor = 0, limit = 100) =>
    j<unknown[]>(
      `/v1/markets/${encodeURIComponent(id)}/tape?cursor=${cursor}&limit=${limit}`
    ),
  trades: (market?: string) => j<Fill[]>(`/v1/trades${market ? `?market=${encodeURIComponent(market)}` : ""}`),
  holders: (id: string) => j<Holders>(`/v1/markets/${encodeURIComponent(id)}/holders`),
  price: () => j<LivePrice>("/v1/price"),
  chart: (id: string, tf?: string) =>
    j<MarketChart>(`/v1/markets/${encodeURIComponent(id)}/chart${tf ? `?tf=${encodeURIComponent(tf)}` : ""}`),
  account: (trader: string, market?: string) =>
    j<Account>(
      `/v1/account?trader=${trader}${market ? `&market=${encodeURIComponent(market)}` : ""}`
    ),
  setReferrer: (body: { trader: string; referrer: string }) =>
    j<{ ok: boolean; trader: string; referrer: string; newly_set: boolean }>("/v1/account/referrer", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  referrals: (trader: string) =>
    j<ReferralsReport>(`/v1/account/referrals?trader=${encodeURIComponent(trader)}`),
  setNickname: (body: { trader: string; nickname: string; nonce: number; signature: string }) =>
    j<{ ok: boolean; trader: string; nickname: string }>("/v1/account/nickname", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  setEmail: (body: { trader: string; email: string; nonce: number; signature: string }) =>
    j<{
      ok: boolean;
      trader: string;
      email: string;
      email_verified: boolean;
      email_sent: boolean;
      verification_code?: string;
      code_expires_at: number;
      resend_after?: number;
    }>("/v1/account/email", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  resendEmailCode: (body: { trader: string; nonce: number; signature: string }) =>
    j<{
      ok: boolean;
      trader: string;
      email: string;
      email_verified: boolean;
      email_sent: boolean;
      verification_code?: string;
      code_expires_at: number;
      resend_after?: number;
    }>("/v1/account/email/resend", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  verifyEmail: (body: { trader: string; code: string }) =>
    j<{ ok: boolean; trader: string; email: string | null; email_verified: boolean }>(
      "/v1/account/email/verify",
      {
        method: "POST",
        body: JSON.stringify(body),
      }
    ),
  ledgerOrders: (trader: string) => j<LedgerOrder[]>(`/v1/ledger/orders?trader=${trader}`),
  ledgerHistory: (trader: string) => j<LedgerTrade[]>(`/v1/ledger/history?trader=${trader}`),
  ledgerPositions: (trader: string) => j<LedgerPos[]>(`/v1/ledger/positions?trader=${trader}`),
  ledgerFunds: (trader: string) => j<LedgerFund[]>(`/v1/ledger/funds?trader=${trader}`),
  notePending: (body: { trader: string; op: string; amount: string; market_id?: string; tx_hash: string }) =>
    j<{ ok: boolean; status: string }>("/v1/ledger/pending", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  place: (body: PlaceOrder) =>
    j<{ order_id: number; fills: number[]; status: string; remaining: number; reason?: string | null }>("/v1/orders", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  cancel: (id: number, body: CancelOrder) =>
    j(`/v1/orders/${id}`, { method: "DELETE", body: JSON.stringify(body) }),
  cancelAll: (body: CancelAll) =>
    j<CancelAllResult>("/v1/orders/cancel-all", { method: "POST", body: JSON.stringify(body) }),
  batch: (body: BatchRequest) =>
    j<BatchResult>("/v1/batch", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  /** Local/dev: 10 ETH + 1000 mock USDC to the wallet (not the exchange). */
  faucet: (address: string) =>
    j<{
      address: string;
      eth_tx_hash: string;
      usdc_tx_hash: string;
      amount_eth: string;
      amount_usdc: string;
    }>("/v1/faucet", {
      method: "POST",
      body: JSON.stringify({ address }),
    }),
};

export function wsUrl(): string {
  if (BASE.startsWith("http")) {
    return BASE.replace(/^http/, "ws") + "/v1/ws";
  }
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/v1/ws`;
}
