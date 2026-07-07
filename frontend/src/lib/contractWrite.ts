import type { Abi, Address, ContractFunctionArgs, ContractFunctionName, PublicClient, WalletClient } from 'viem';
import { BaseError, decodeErrorResult } from 'viem';
import { sepolia } from 'viem/chains';
import { blackjackAbi } from '@/lib/blackjackAbi';

/** Measured on-chain gas with headroom — prevents wallets/RPCs from rejecting inflated estimates. */
const GAS_CEILINGS: Partial<Record<string, bigint>> = {
  claimFreeChips: 120_000n,
  buyChips: 180_000n,
  withdrawChips: 200_000n,
  createTable: 200_000n,
  joinTable: 300_000n,
  leaveTable: 350_000n,
  cashOut: 300_000n,
  topUpTableChips: 200_000n,
  placeBet: 200_000n,
  hit: 200_000n,
  stand: 200_000n,
  doubleDown: 220_000n,
  forceAdvanceOnTimeout: 250_000n
};

const GAS_BUFFER_NUM = 140n;
const GAS_BUFFER_DEN = 100n;
const DEFAULT_GAS_CEILING = 500_000n;

const revertHints: Record<string, string> = {
  InsufficientChips: 'Claim free chips or buy more chips before joining.',
  AlreadyAtTable: 'Leave your current table before joining another.',
  InvalidBuyIn: 'Buy-in must be between the table min and max.',
  TableFull: 'This table is full — try another table.',
  TableDNE: 'That table does not exist.',
  BettingClosed: 'Betting is closed for this hand.',
  NotYourTurn: 'Wait for your turn before acting.',
  TableInactive: 'This table is not active. Solo play requires the latest contract — redeploy and refresh.',
  OraclePending: 'Wait for the table to finish processing the last action.',
  PlayerBustedAction: 'You busted — no further actions are needed.',
  AlreadyBet: 'You already placed a bet for this hand.',
  HandInProgress: 'Wait for the current hand to finish before joining.',
  PromoChipsNotWithdrawable: 'Only chips purchased with ETH can be withdrawn.',
  ContractPaused: 'The game is paused — try again shortly.',
  LeaveTableFirst: 'Leave your table before moving chips in or out of your wallet.',
  SendEth: 'Send ETH with this transaction to buy chips.',
  AmountTooSmall: 'That ETH amount is too small to buy chips. Try a slightly larger amount.',
  ZeroAmount: 'Enter an amount greater than zero.',
  AlreadyClaimedFreeChips: 'You have already claimed your free chips.',
  ContractLacksEth: 'Withdrawals are temporarily unavailable — the house bank is low on ETH.',
  EthTransferFailed: 'ETH transfer failed. Try again or use a smaller amount.'
};

function collectErrorText(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  let depth = 0;
  while (current && depth < 8) {
    if (typeof current === 'object' && current !== null) {
      const obj = current as Record<string, unknown>;
      if (typeof obj.shortMessage === 'string') parts.push(obj.shortMessage);
      if (typeof obj.message === 'string') parts.push(obj.message);
      if (typeof obj.details === 'string') parts.push(obj.details);
    }
    current = (current as { cause?: unknown })?.cause;
    depth += 1;
  }
  return parts.join(' ');
}

function extractRevertData(error: unknown): `0x${string}` | undefined {
  if (error instanceof BaseError) {
    const revertError = error.walk((err) => {
      const data = (err as { data?: unknown }).data;
      return typeof data === 'string' && data.startsWith('0x') && data.length > 10;
    });
    const data = (revertError as { data?: `0x${string}` } | undefined)?.data;
    if (data) return data;
  }

  let current: unknown = error;
  let depth = 0;
  while (current && depth < 8) {
    if (typeof current === 'object' && current !== null) {
      const data = (current as { data?: unknown }).data;
      if (typeof data === 'string' && data.startsWith('0x') && data.length > 10) {
        return data as `0x${string}`;
      }
    }
    current = (current as { cause?: unknown })?.cause;
    depth += 1;
  }
  return undefined;
}

export const friendlyRevertMessage = (error: unknown): string | undefined => {
  const message = collectErrorText(error);

  for (const [needle, hint] of Object.entries(revertHints)) {
    if (message.includes(needle)) return hint;
  }

  const data = extractRevertData(error);
  if (data) {
    try {
      const decoded = decodeErrorResult({ abi: blackjackAbi, data });
      const hint = revertHints[decoded.errorName];
      if (hint) return hint;
    } catch {
      // Not a known custom error payload.
    }
  }

  if (/insufficient funds/i.test(message)) {
    return 'Your wallet does not have enough Sepolia ETH for this transaction and network fees.';
  }
  if (/rejected|denied|cancel/i.test(message)) {
    return 'Transaction was cancelled in your wallet.';
  }
  if (/gas limit too high/i.test(message)) {
    return 'Your wallet rejected this transaction. Refresh the page and try again.';
  }
  if (/nonce too low/i.test(message)) {
    return 'A previous transaction is still pending. Wait a moment and try again.';
  }
  return undefined;
};

type WriteParams<
  TFunctionName extends ContractFunctionName<typeof blackjackAbi, 'nonpayable' | 'payable'>
> = {
  publicClient: PublicClient;
  walletClient: WalletClient;
  contractAddress: Address;
  functionName: TFunctionName;
  args?: ContractFunctionArgs<typeof blackjackAbi, 'nonpayable' | 'payable', TFunctionName>;
  value?: bigint;
};

const capGas = (functionName: string, estimate: bigint): bigint => {
  const ceiling = GAS_CEILINGS[functionName] ?? DEFAULT_GAS_CEILING;
  const buffered = (estimate * GAS_BUFFER_NUM) / GAS_BUFFER_DEN;
  return buffered < ceiling ? buffered : ceiling;
};

export async function writeBlackjackContract<
  TFunctionName extends ContractFunctionName<typeof blackjackAbi, 'nonpayable' | 'payable'>
>({
  publicClient,
  walletClient,
  contractAddress,
  functionName,
  args = [] as ContractFunctionArgs<typeof blackjackAbi, 'nonpayable' | 'payable', TFunctionName>,
  value
}: WriteParams<TFunctionName>): Promise<`0x${string}`> {
  const account = walletClient.account;
  if (!account) {
    throw new Error('Wallet account is not connected.');
  }

  const walletChainId = await walletClient.getChainId();
  if (walletChainId !== sepolia.id) {
    throw new Error('Switch your wallet to Sepolia before submitting this transaction.');
  }

  const simulateArgs = {
    address: contractAddress,
    abi: blackjackAbi,
    functionName,
    args,
    account,
    value
  } as const;

  const { request } = await publicClient.simulateContract(simulateArgs);
  const simulatedGas = request.gas ?? GAS_CEILINGS[String(functionName)] ?? DEFAULT_GAS_CEILING;
  const gas = capGas(String(functionName), simulatedGas);

  return walletClient.writeContract({
    ...request,
    gas
  });
}