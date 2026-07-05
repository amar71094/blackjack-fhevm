import type { PublicClient } from 'viem';

export const TX_RECEIPT_TIMEOUT_MS = 120_000;

export async function waitForTxReceipt(publicClient: PublicClient, hash: `0x${string}`) {
  return publicClient.waitForTransactionReceipt({
    hash,
    timeout: TX_RECEIPT_TIMEOUT_MS
  });
}