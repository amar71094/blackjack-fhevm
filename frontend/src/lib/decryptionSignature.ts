import type { FhevmInstance } from '@zama-fhe/relayer-sdk/web';
import type { WalletClient, Address } from 'viem';
import { BrowserProvider, ethers } from 'ethers';

export type StoredDecryptionSignature = {
  publicKey: string;
  privateKey: string;
  signature: string;
  userAddress: `0x${string}`;
  contractAddresses: `0x${string}`[];
  startTimestamp: number;
  durationDays: number;
};

const STORAGE_PREFIX = 'fhevm-blackjack-signature';
const ONE_DAY_SECONDS = 24 * 60 * 60;
const DEFAULT_DURATION_DAYS = 1;

const memoryStore = new Map<string, string>();

type StorageProvider = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
};

const sanitizeTypes = (
  types?: Record<string, Array<{ name: string; type: string }>>
): Record<string, Array<{ name: string; type: string }>> => {
  if (!types) {
    return {};
  }
  return Object.fromEntries(Object.entries(types).filter(([typeName]) => typeName !== 'EIP712Domain'));
};

const resolveStorage = (): StorageProvider => {
  if (typeof window !== 'undefined' && window.sessionStorage) {
    return window.sessionStorage;
  }
  return {
    getItem: (key) => memoryStore.get(key) ?? null,
    setItem: (key, value) => {
      memoryStore.set(key, value);
    },
    removeItem: (key) => {
      memoryStore.delete(key);
    }
  };
};

const signatureStorageKey = (userAddress: string, contractAddress: string) =>
  `${STORAGE_PREFIX}:${userAddress.toLowerCase()}:${contractAddress.toLowerCase()}`;

const isSignatureValid = (signature: StoredDecryptionSignature): boolean => {
  const expiresAt = signature.startTimestamp + signature.durationDays * ONE_DAY_SECONDS;
  return Math.floor(Date.now() / 1000) < expiresAt;
};

type SignatureContext =
  | { browserProvider: BrowserProvider; walletClient?: never }
  | { browserProvider?: never; walletClient: WalletClient };

export const loadOrCreateSignature = async (
  instance: FhevmInstance,
  contractAddress: `0x${string}`,
  context: SignatureContext
): Promise<StoredDecryptionSignature> => {
  let userAddress: `0x${string}`;
  let signTypedData: (
    domain: Record<string, unknown>,
    types: Record<string, Array<{ name: string; type: string }>>,
    message: Record<string, unknown>,
    primaryType?: string
  ) => Promise<string>;

  if ('browserProvider' in context && context.browserProvider) {
    const signer = await context.browserProvider.getSigner();
    userAddress = (await signer.getAddress()) as `0x${string}`;
    signTypedData = (domain, types, message) =>
      signer.signTypedData(
        domain as ethers.TypedDataDomain,
        types as Record<string, ethers.TypedDataField[]>,
        message
      );
  } else if ('walletClient' in context && context.walletClient) {
    const client = context.walletClient;
    let accountAddress: Address | undefined = client.account?.address;
    if (!accountAddress) {
      const addresses = await client.getAddresses();
      accountAddress = addresses[0];
    }
    if (!accountAddress) {
      throw new Error('Wallet client does not have an active account to sign typed data.');
    }
    userAddress = accountAddress as `0x${string}`;
    signTypedData = async (domain, types, message, primaryType) => {
      const sanitizedTypesEntries = Object.entries(types ?? {}).filter(([typeName]) => typeName !== 'EIP712Domain');
      const sanitizedTypes = Object.fromEntries(sanitizedTypesEntries) as Record<string, { name: string; type: string }[]>;
      return client.signTypedData({
        account: accountAddress,
        domain,
        primaryType: (primaryType ?? 'UserDecryptRequestVerification') as
          | 'UserDecryptRequestVerification'
          | 'DelegatedUserDecryptRequestVerification',
        types: sanitizedTypes,
        message
      }) as unknown as Promise<string>;
    };
  } else {
    throw new Error('No signing context available for FHE decryption.');
  }

  const storage = resolveStorage();
  const storageKey = signatureStorageKey(userAddress, contractAddress);

  const cached = storage.getItem(storageKey);
  if (cached) {
    try {
      const parsed = JSON.parse(cached) as StoredDecryptionSignature;
      if (
        parsed.userAddress.toLowerCase() === userAddress.toLowerCase() &&
        parsed.contractAddresses[0]?.toLowerCase() === contractAddress.toLowerCase() &&
        isSignatureValid(parsed)
      ) {
        return parsed;
      }
      storage.removeItem(storageKey);
    } catch {
      storage.removeItem(storageKey);
    }
  }

  const { publicKey, privateKey } = instance.generateKeypair();
  const startTimestamp = Math.floor(Date.now() / 1000);
  const durationDays = DEFAULT_DURATION_DAYS;
  const contractAddresses = [contractAddress];

  const eip712 = instance.createEIP712(publicKey, contractAddresses, startTimestamp, durationDays);
  const sanitizedTypes = sanitizeTypes(eip712.types as Record<string, Array<{ name: string; type: string }>>);

  const signature = await signTypedData(
    eip712.domain as Record<string, unknown>,
    sanitizedTypes,
    eip712.message as Record<string, unknown>,
    eip712.primaryType as string | undefined
  );

  const record: StoredDecryptionSignature = {
    publicKey,
    privateKey,
    signature,
    userAddress,
    contractAddresses,
    startTimestamp,
    durationDays
  };

  try {
    storage.setItem(storageKey, JSON.stringify(record));
  } catch {
    // ignore persistence errors (private browsing, storage quotas)
  }

  return record;
};

export const invalidateStoredSignature = (contractAddress: `0x${string}`, userAddress: `0x${string}`) => {
  const storage = resolveStorage();
  storage.removeItem(signatureStorageKey(userAddress, contractAddress));
};

export const clearAllStoredSignatures = (userAddress?: string) => {
  const storage = resolveStorage();
  const prefix = userAddress
    ? `${STORAGE_PREFIX}:${userAddress.toLowerCase()}:`
    : `${STORAGE_PREFIX}:`;
  if (typeof window === 'undefined' || !window.sessionStorage) {
    for (const key of [...memoryStore.keys()]) {
      if (key.startsWith(prefix)) memoryStore.delete(key);
    }
    return;
  }
  const keysToRemove: string[] = [];
  for (let i = 0; i < window.sessionStorage.length; i++) {
    const key = window.sessionStorage.key(i);
    if (key?.startsWith(prefix)) keysToRemove.push(key);
  }
  keysToRemove.forEach((key) => storage.removeItem(key));
};
