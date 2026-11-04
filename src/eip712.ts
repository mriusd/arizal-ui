import type { SignedOrder } from "./api/types";
import { keccak256, parseUnits, toBytes } from "viem";

/** Human-readable EIP-712 types — MetaMask shows these strings in the signature prompt. */
export const orderTypes = {
  Order: [
    { name: "trader", type: "address" },
    { name: "marketId", type: "string" },
    { name: "side", type: "string" },
    { name: "price", type: "uint8" },
    { name: "size", type: "uint256" },
    { name: "orderType", type: "string" },
    { name: "tif", type: "string" },
    { name: "nonce", type: "uint256" },
    { name: "salt", type: "uint256" },
    { name: "expiresAt", type: "uint256" },
  ],
} as const;

export const cancelTypes = {
  Cancel: [
    { name: "trader", type: "address" },
    { name: "orderId", type: "uint256" },
    { name: "marketId", type: "string" },
    { name: "nonce", type: "uint256" },
  ],
} as const;

export const mergeTypes = {
  Merge: [
    { name: "trader", type: "address" },
    { name: "marketId", type: "string" },
    { name: "shares", type: "uint256" },
    { name: "nonce", type: "uint256" },
  ],
} as const;

export const splitTypes = {
  Split: [
    { name: "trader", type: "address" },
    { name: "marketId", type: "string" },
    { name: "shares", type: "uint256" },
    { name: "nonce", type: "uint256" },
  ],
} as const;

export const faucetTypes = {
  Faucet: [
    { name: "trader", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "nonce", type: "uint256" },
  ],
} as const;

export const FAUCET_USDC = 1000n * 1_000_000n;

export const cancelAllTypes = {
  CancelAll: [
    { name: "trader", type: "address" },
    { name: "marketId", type: "string" },
    { name: "nonce", type: "uint256" },
  ],
} as const;

/** Empty string — CancelAll for every market (hashed as EIP-712 `string`). */
export const CANCEL_ALL_MARKETS = "";

export function cancelAllMarketId(marketId?: string): string {
  return marketId && marketId.length > 0 ? marketId : CANCEL_ALL_MARKETS;
}

/** On-chain market key = keccak256(utf8(id)); same as EIP-712 string hash of `id`. */
export function marketIdHash(id: string): `0x${string}` {
  return keccak256(toBytes(id));
}

export function orderMessage(o: SignedOrder) {
  return {
    trader: o.trader as `0x${string}`,
    marketId: o.market_id,
    side: o.side,
    price: o.price,
    size: parseUnits(String(o.size), 6),
    orderType: o.order_type,
    tif: o.tif,
    nonce: BigInt(o.nonce),
    salt: BigInt(o.salt),
    expiresAt: BigInt(o.expires_at),
  };
}

export function domain(chainId: number, verifyingContract: `0x${string}`) {
  return {
    name: "Arizal",
    version: "1",
    chainId,
    verifyingContract,
  };
}
