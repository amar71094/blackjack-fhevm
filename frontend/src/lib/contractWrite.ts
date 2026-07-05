import type { Abi, Address, ContractFunctionArgs, ContractFunctionName, PublicClient, WalletClient } from 'viem';
import { sepolia } from 'viem/chains';
import { blackjackAbi } from '@/lib/blackjackAbi';

/** Measured on-chain gas with headroom — prevents wallets/RPCs from rejecting inflated estimates. */
const GAS_CEILINGS: Partial<Record<string, bigint>> = {
  claimFreeChips: 120_000n,
  buyChips: 120_000n,
  withdrawChips: 150_000n,
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
  OraclePending: 'Wait for the oracle to finish the last action.',
  PlayerBustedAction: 'You busted — no further actions are needed.',
  AlreadyBet: 'You already placed a bet for this hand.',
  HandInProgress: 'Wait for the current hand to finish before joining.',
  PromoChipsNotWithdrawable: 'Only chips purchased with ETH can be withdrawn.',
  ContractPaused: 'The game is paused — try again shortly.',
  LeaveTableFirst: 'Leave your table before moving chips in or out of your wallet.'
};

export const friendlyRevertMessage = (error: unknown): string | undefined => {
  const message =
    (error as { shortMessage?: string })?.shortMessage ??
    (error as { cause?: { shortMessage?: string } })?.cause?.shortMessage ??
    (error as Error)?.message ??
    '';
  for (const [needle, hint] of Object.entries(revertHints)) {
    if (message.includes(needle)) return hint;
  }
  if (message.includes('gas limit too high')) {
    return 'Wallet rejected the gas limit. Retry after refreshing, or disable MetaMask Smart Transactions / Added Protection for Sepolia.';
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

  let gas: bigint;
  try {
    const estimate = await publicClient.estimateContractGas(simulateArgs);
    gas = capGas(String(functionName), estimate);
  } catch {
    gas = GAS_CEILINGS[String(functionName)] ?? DEFAULT_GAS_CEILING;
  }

  return walletClient.writeContract({
    ...request,
    gas
  });
}