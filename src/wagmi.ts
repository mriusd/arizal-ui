import { createAppKit } from "@reown/appkit";
import { WagmiAdapter } from "@reown/appkit-adapter-wagmi";
import {
  ApiController,
  ChainController,
  ConnectionController,
  ConnectorController,
} from "@reown/appkit-controllers";
import { localChain } from "./chain";

export { localChain } from "./chain";

/** Reown / WalletConnect Cloud project id (`VITE_WC_PROJECT_ID`). */
const projectId =
  (import.meta.env.VITE_WC_PROJECT_ID as string | undefined)?.trim() ||
  "897853f9990c9a1749ade3fa5ae5eb37";

const metadata = {
  name: "Arizal Exchange",
  description: "Crypto prediction markets",
  url: typeof window !== "undefined" ? window.location.origin : "https://app.arizal.xyz",
  icons: ["https://app.arizal.xyz/logo.svg"],
};

export const wagmiAdapter = new WagmiAdapter({
  projectId,
  networks: [localChain],
});

/** Wagmi config from AppKit adapter (injected + WalletConnect, extension-aware modal). */
export const config = wagmiAdapter.wagmiConfig;

export const appKit = createAppKit({
  adapters: [wagmiAdapter],
  projectId,
  networks: [localChain],
  defaultNetwork: localChain,
  allowUnsupportedChain: true,
  enableEIP6963: true,
  enableInjected: true,
  enableCoinbase: false,
  metadata,
  features: {
    analytics: false,
    email: false,
    socials: false,
  },
});

type MipdStore = {
  getProviders: () => Array<{ info: { rdns: string } }>;
};

function mipdProviders(): Array<{ info: { rdns: string } }> {
  const mipd = (
    config as unknown as { _internal?: { mipd?: MipdStore } }
  )._internal?.mipd;
  return mipd?.getProviders() ?? [];
}

function connectorMatchesId(
  connector: { id: string; info?: { rdns?: string | null }; explorerId?: string; explorerWallet?: { id?: string } },
  id: string,
): boolean {
  return (
    connector.id === id ||
    connector.explorerId === id ||
    connector.explorerWallet?.id === id ||
    connector.info?.rdns === id
  );
}

/**
 * AppKit's default checkInstalled only does `window.ethereum[rdns]`, which is false
 * for EIP-6963 wallets (Rabby, etc.). Prefer mipd + already-synced connectors.
 */
const connectionClient = ConnectionController._getClient();
if (connectionClient) {
  const legacyCheck = connectionClient.checkInstalled?.bind(connectionClient);
  ConnectionController.setClient({
    ...connectionClient,
    checkInstalled(ids?: string[]) {
      if (typeof window === "undefined") return false;
      if (!ids?.length) return Boolean(window.ethereum);
      if (mipdProviders().some((p) => ids.includes(p.info.rdns))) return true;
      if (
        ConnectorController.state.connectors.some(
          (c) => ids.includes(c.id) || (c.info?.rdns != null && ids.includes(c.info.rdns)),
        )
      ) {
        return true;
      }
      return legacyCheck?.(ids) ?? false;
    },
  });
}

/**
 * When the user picks an explorer wallet (by WC id), match the installed EIP-6963
 * connector by rdns so AppKit opens ConnectingExternal instead of "Not Detected".
 */
const baseGetConnector = ConnectorController.getConnector.bind(ConnectorController);
ConnectorController.getConnector = ({ id, namespace }) => {
  const found = baseGetConnector({ id, namespace });
  if (found) return found;

  const namespaceToUse = namespace || ChainController.state.activeChain;
  const connectors = ConnectorController.state.allConnectors.filter(
    (c) => !namespaceToUse || c.chain === namespaceToUse,
  );

  const byExplorer = connectors.find((c) => connectorMatchesId(c, id));
  if (byExplorer) return byExplorer;

  const wallets = [
    ...(ApiController.state.recommended ?? []),
    ...(ApiController.state.featured ?? []),
    ...(ApiController.state.explorerWallets ?? []),
    ...(ApiController.state.explorerFilteredWallets ?? []),
  ];
  const wallet = wallets.find((w) => w.id === id);
  if (wallet?.rdns) {
    return connectors.find(
      (c) => c.info?.rdns === wallet.rdns || c.id === wallet.rdns,
    );
  }

  const mipd = mipdProviders().find((p) => {
    const w = wallets.find((entry) => entry.id === id);
    return w?.rdns != null && p.info.rdns === w.rdns;
  });
  if (mipd) {
    return connectors.find((c) => c.id === mipd.info.rdns || c.info?.rdns === mipd.info.rdns);
  }

  return undefined;
};
