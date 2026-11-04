import { defineChain } from "viem";
import { createConfig, http } from "wagmi";
import { injected, walletConnect } from "wagmi/connectors";

const chainId = Number(import.meta.env.VITE_CHAIN_ID || 31337);
const rpcUrl = (import.meta.env.VITE_RPC_URL as string | undefined) || "http://127.0.0.1:8545";
const chainName = (import.meta.env.VITE_CHAIN_NAME as string | undefined) || "Hardhat Local";

/** The chain this UI talks to. Defaults to local Hardhat. Never Ethereum mainnet. */
export const localChain = defineChain({
  id: chainId,
  name: chainName,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: [rpcUrl] },
  },
});

const wc = import.meta.env.VITE_WC_PROJECT_ID as string | undefined;

export const config = createConfig({
  chains: [localChain],
  connectors: wc
    ? [injected({ shimDisconnect: true }), walletConnect({ projectId: wc })]
    : [injected({ shimDisconnect: true })],
  transports: {
    [localChain.id]: http(rpcUrl),
  },
});
