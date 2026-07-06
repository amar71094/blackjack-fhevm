import { fallback, http, webSocket } from 'viem';
import { createConfig } from 'wagmi';
import { sepolia } from 'wagmi/chains';
import { injected, walletConnect } from 'wagmi/connectors';
import type { Connector } from 'wagmi';

const sepoliaRpcUrl = import.meta.env.VITE_SEPOLIA_RPC_URL;
const walletConnectProjectId = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID;

const runtimeUrl = import.meta.env.VITE_APP_PUBLIC_URL
  ?? (typeof window !== 'undefined' ? window.location.origin : 'https://cipherjack.xyz');
const runtimeIcon = import.meta.env.VITE_APP_ICON_URL ?? 'https://cipherjack.xyz/assets/cipherjack-logo-DyVLB6l4.jpeg';

const walletConnectMetadata = {
  name: 'CipherJack Blackjack',
  description: 'Private blackjack with real chip wagers.',
  url: runtimeUrl,
  icons: [runtimeIcon],
  redirect: {
    native: 'cipherjack://',
    universal: runtimeUrl
  }
} as const;

export const injectedConnector = injected({
  shimDisconnect: true
});

export const walletConnectConnector = walletConnectProjectId
  ? walletConnect({
      projectId: walletConnectProjectId,
      metadata: walletConnectMetadata,
      showQrModal: true,
      qrModalOptions: {
        themeMode: 'dark',
        enableExplorer: true,
        explorerRecommendedWalletIds: 'NONE'
      }
    })
  : null;

const configuredConnectors: readonly Connector[] = [
  injectedConnector,
  ...(walletConnectConnector ? [walletConnectConnector] : [])
];

export const hasWalletConnect = Boolean(walletConnectConnector);

const buildSepoliaTransport = () => {
  if (!sepoliaRpcUrl) return http();
  if (/alchemy\.com/i.test(sepoliaRpcUrl)) {
    const wsUrl = sepoliaRpcUrl.replace(/^https:/i, 'wss:');
    return fallback([webSocket(wsUrl), http(sepoliaRpcUrl)]);
  }
  return http(sepoliaRpcUrl);
};

export const wagmiConfig = createConfig({
  chains: [sepolia],
  connectors: configuredConnectors,
  transports: {
    [sepolia.id]: buildSepoliaTransport()
  },
  ssr: false
});

export const supportedChains = [sepolia];
