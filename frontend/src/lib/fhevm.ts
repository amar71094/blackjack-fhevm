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

const normalizeHandleKey = (value: string): string => hexlifyHandle(value).toLowerCase();

/** Coerce relayer clear text (bigint | number | hex string) to a finite number. */
export const coerceClearNumber = (value: unknown): number => {
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return Number.NaN;
    if (/^0x/i.test(trimmed)) return Number(BigInt(trimmed));
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : Number.NaN;
  }
  return Number.NaN;
};

/** publicDecrypt returns `{ clearValues }`; userDecrypt returns the map directly. */
export const extractPublicDecryptClearValues = (
  decrypted: ClearValueMap | { clearValues?: ClearValueMap }
): ClearValueMap => {
  const wrapped = decrypted as { clearValues?: ClearValueMap };
  if (wrapped.clearValues && typeof wrapped.clearValues === 'object') {
    return wrapped.clearValues;
  }
  return decrypted as ClearValueMap;
};

export const readClearValue = (
  decrypted: ClearValueMap | { clearValues?: ClearValueMap },
  handle: string
): unknown => {
  const normalized = normalizeHandleKey(handle);
  const maps: ClearValueMap[] = [extractPublicDecryptClearValues(decrypted)];

  for (const map of maps) {
    if (map[normalized] !== undefined) {
      return map[normalized];
    }
    for (const [key, value] of Object.entries(map)) {
      if (normalizeHandleKey(key) === normalized) {
        return value;
      }
    }
  }
  return undefined;
};

/** Resolve a ciphertext handle against a public-decrypt or user-decrypt payload. */
export const lookupDecryptedHandle = (
  decrypted: ClearValueMap | { clearValues?: ClearValueMap },
  handle: string
): unknown => {
  const hexKey = hexlifyHandle(handle);
  const direct = decrypted as ClearValueMap;
  if (direct && typeof direct === 'object' && direct[hexKey] !== undefined) {
    return direct[hexKey];
  }
  return readClearValue(decrypted, handle);
};