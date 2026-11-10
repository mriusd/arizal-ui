/**
 * Explicit state machines for arizal-ui.
 *
 * Inventory of previously *implicit* machines (see also `.cursor/rules/state-machines.mdc`):
 *
 * 1. Connection health — HTTP config/ledger vs WS live feed
 * 2. Overlay — at most one of markets picker / fee tiers / custom expiry / account / refer
 * 3. Place order — idle vs in-flight (sign + POST)
 * 4. Trading session — main wallet vs authorized 1-click key (ApproveAgent in localStorage)
 * 5. Limit expiry — Never | preset | custom applied | saved preset
 * 6. Entry mode — limit | market | merge | split × buy/sell × Yes/No
 * 7. Fill settlement — engine fill → pending History → confirmed (tx / indexer)
 * 8. Market lifecycle — Upcoming → Open → Locked → Resolved (+ redeem)
 * 9. WS reconnect — exponential backoff after close/error
 *
 * Prefer these helpers over ad-hoc booleans when adding UI.
 */

/** Live transport health shown in the header. */
export type ConnHealth = "ok" | "reconnecting";

export function connHealthFromFlags(apiDown: boolean, wsDown: boolean): ConnHealth {
  return apiDown || wsDown ? "reconnecting" : "ok";
}

/**
 * Exclusive UI overlays. Opening one closes the others so agents/users never
 * stack dialogs or fight z-index.
 */
export type Overlay = null | "markets" | "fees" | "expiry" | "account" | "refer";

/** Place / close order submission. Blocks double-submit. */
export type PlacePhase = "idle" | "placing";

/** Derived 1-click trading session (local key ∩ stored ApproveAgent). */
export type TradingSession = "disconnected" | "off" | "on";

export function tradingSessionOf(walletOn: boolean, enabled: boolean): TradingSession {
  if (!walletOn) return "disconnected";
  return enabled ? "on" : "off";
}
