import type { SignedOrder } from "./api/types";
import { getAddress, keccak256, parseUnits, toBytes, type Address } from "viem";

/** Human-readable EIP-712 types — MetaMask shows these strings in the signature prompt. */
export const orderTypes = {
  Order: [
    { name: "trader", type: "address" },
    { name: "marketId", type: "string" },
    { name: "side", type: "string" },
    { name: "price", type: "uint16" },
    { name: "size", type: "uint256" },
    { name: "orderType", type: "string" },
    { name: "tif", type: "string" },
    { name: "nonce", type: "uint256" },
    { name: "salt", type: "uint256" },
    { name: "expiresAt", type: "uint256" },
    { name: "gasFee", type: "uint256" },
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
    gasFee: BigInt(o.gas_fee ?? 0),
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

/** Human-readable personal_sign body — must match clearbook-crypto `set_nickname_message`. */
export function setNicknameMessage(trader: Address, nickname: string, nonce: number, chainId: number): string {
  return `Arizal Set Nickname\n\nWallet: ${getAddress(trader)}\nNickname: ${nickname}\nNonce: ${nonce}\nChain ID: ${chainId}`;
}

/** Human-readable personal_sign body — must match clearbook-crypto `set_email_message`. */
export function setEmailMessage(trader: Address, email: string, nonce: number, chainId: number): string {
  return `Arizal Set Email\n\nWallet: ${getAddress(trader)}\nEmail: ${email}\nNonce: ${nonce}\nChain ID: ${chainId}`;
}

/** Human-readable personal_sign body — must match clearbook-crypto `resend_email_code_message`. */
export function resendEmailCodeMessage(
  trader: Address,
  email: string,
  nonce: number,
  chainId: number
): string {
  return `Arizal Resend Email Code\n\nWallet: ${getAddress(trader)}\nEmail: ${email}\nNonce: ${nonce}\nChain ID: ${chainId}`;
}
