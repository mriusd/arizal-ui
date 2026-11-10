import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import type { Address, Hex } from "viem";

export interface StoredAgentAuth {
  arizal_chain: string;
  agent_address: Address;
  nonce: number;
  expires_at: number;
  signature: Hex;
}

function storeKey(trader: Address): string {
  return `arizal.tradingKey.${trader.toLowerCase()}`;
}

function authKey(trader: Address): string {
  return `arizal.agentAuth.${trader.toLowerCase()}`;
}

/** Load the browser-stored trading key for `trader`, or null if none. */
export function loadTradingAccount(trader: Address): PrivateKeyAccount | null {
  const pk = localStorage.getItem(storeKey(trader)) as Hex | null;
  if (!pk || !pk.startsWith("0x") || pk.length !== 66) return null;
  try {
    return privateKeyToAccount(pk);
  } catch {
    return null;
  }
}

/** Create (or replace) a trading key for `trader` and persist it in localStorage. */
export function createTradingAccount(trader: Address): PrivateKeyAccount {
  const pk = generatePrivateKey();
  localStorage.setItem(storeKey(trader), pk);
  return privateKeyToAccount(pk);
}

/** Persist the signed ApproveAgent grant used with settleFill / place. */
export function saveAgentAuth(trader: Address, auth: StoredAgentAuth) {
  localStorage.setItem(authKey(trader), JSON.stringify(auth));
}

/** Load stored ApproveAgent; null if missing, malformed, or expired. */
export function loadAgentAuth(trader: Address): StoredAgentAuth | null {
  const raw = localStorage.getItem(authKey(trader));
  if (!raw) return null;
  try {
    const a = JSON.parse(raw) as StoredAgentAuth;
    if (
      !a?.agent_address ||
      !a?.signature ||
      typeof a.expires_at !== "number" ||
      typeof a.nonce !== "number" ||
      typeof a.arizal_chain !== "string"
    ) {
      return null;
    }
    const now = Math.floor(Date.now() / 1000);
    if (a.expires_at <= now) return null;
    return a;
  } catch {
    return null;
  }
}

/** Remove the stored trading key + ApproveAgent for `trader` (no chain tx). */
export function clearTradingAccount(trader: Address) {
  localStorage.removeItem(storeKey(trader));
  localStorage.removeItem(authKey(trader));
}
