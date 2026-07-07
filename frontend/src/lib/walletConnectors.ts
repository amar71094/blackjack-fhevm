import type { Connector } from 'wagmi';

/** Visible wallet options for the connect popover — drops unnamed EIP-6963 entries and redundant injected fallback. */
export function getWalletConnectorsForDisplay(connectors: readonly Connector[]): Connector[] {
  const byId = new Map<string, Connector>();

  for (const connector of connectors) {
    if (!connector?.id || !connector.name?.trim()) continue;
    byId.set(connector.id, connector);
  }

  const list = Array.from(byId.values());
  const hasNamedInjected = list.some(
    (connector) => connector.type === 'injected' && connector.id !== 'injected'
  );
  const filtered = hasNamedInjected
    ? list.filter((connector) => connector.id !== 'injected')
    : list;

  filtered.sort((a, b) => {
    if (a.id === b.id) return 0;
    if (a.id === 'walletConnect') return -1;
    if (b.id === 'walletConnect') return 1;
    if (a.id === 'injected') return 1;
    if (b.id === 'injected') return -1;
    return a.name.localeCompare(b.name);
  });

  return filtered;
}