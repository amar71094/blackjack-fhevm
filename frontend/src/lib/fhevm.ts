import type { FhevmInstance } from '@zama-fhe/relayer-sdk/web';
import { BrowserProvider, ethers } from 'ethers';

export const BLACKJACK_CONTRACT_ADDRESS = import.meta.env.VITE_BLACKJACK_CONTRACT ?? '';

const RPC_URL = import.meta.env.VITE_FHE_RPC_URL ?? import.meta.env.VITE_SEPOLIA_RPC_URL ?? '';

let instance: FhevmInstance | null = null;
let instancePromise: Promise<FhevmInstance> | null = null;

const ensureRpcConfigured = () => {
  if (!RPC_URL) {
    throw new Error('VITE_FHE_RPC_URL or VITE_SEPOLIA_RPC_URL is required for FHE decryption.');
  }
};

/** Lazy-load the relayer SDK (medium: avoids blocking initial bundle). */
export const ensureFhevmInstance = async (): Promise<FhevmInstance> => {
  if (instance) return instance;
  if (instancePromise) return instancePromise;

  ensureRpcConfigured();

  instancePromise = (async () => {
    const { initSDK, createInstance, SepoliaConfig } = await import('@zama-fhe/relayer-sdk/web');
    await initSDK({ thread: 0 });
    const created = await createInstance({
      ...SepoliaConfig,
      network: RPC_URL
    });
    instance = created;
    return created;
  })().catch((error) => {
    instancePromise = null;
    throw error;
  });

  return instancePromise;
};

export const getBrowserProvider = async (): Promise<BrowserProvider> => {
  const { ethereum } = window as typeof window & { ethereum?: ethers.Eip1193Provider };
  if (!ethereum) {
    throw new Error('A browser wallet is required for card decryption.');
  }
  return new BrowserProvider(ethereum);
};

export const hexlifyHandle = (value: string): string => ethers.hexlify(value as `0x${string}`);

type ClearValueMap = Readonly<Record<string, unknown>>;

/** publicDecrypt returns `{ clearValues }`; userDecrypt returns the map directly. */
export const readClearValue = (
  decrypted: ClearValueMap | { clearValues?: ClearValueMap },
  handle: string
): unknown => {
  const normalized = hexlifyHandle(handle);
  const direct = decrypted as ClearValueMap;
  if (normalized in direct) return direct[normalized];
  const wrapped = decrypted as { clearValues?: ClearValueMap };
  if (wrapped.clearValues && normalized in wrapped.clearValues) {
    return wrapped.clearValues[normalized];
  }
  return undefined;
};