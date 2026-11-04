import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import type { Address, Hex } from "viem";

function storeKey(trader: Address): string {
  return `arizal.tradingKey.${trader.toLowerCase()}`;
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

/** Remove the stored trading key for `trader` (does not clear on-chain agent). */
export function clearTradingAccount(trader: Address) {
  localStorage.removeItem(storeKey(trader));
}
