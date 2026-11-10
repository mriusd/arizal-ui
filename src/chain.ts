import { defineChain } from "viem";

const chainId = Number(import.meta.env.VITE_CHAIN_ID || 31337);
const chainName = (import.meta.env.VITE_CHAIN_NAME as string | undefined) || "Hardhat Local";

/**
 * Page/wagmi RPC. Prefer `VITE_RPC_URL`; otherwise same-origin `/rpc` (Vite → Hardhat)
 * so https://app.arizal.xyz never fetches http://127.0.0.1:8545 (browser PNA block).
 */
export function resolveRpcUrl(): string {
  const fromEnv = (import.meta.env.VITE_RPC_URL as string | undefined)?.trim();
  if (fromEnv) return fromEnv;
  if (typeof window !== "undefined") return `${window.location.origin}/rpc`;
  return "http://127.0.0.1:8545";
}

/** The chain this UI talks to. Defaults to local Hardhat. Never Ethereum mainnet. */
export const localChain = defineChain({
  id: chainId,
  name: chainName,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: [resolveRpcUrl()] },
  },
});
