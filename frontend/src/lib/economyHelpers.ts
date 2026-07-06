import type { Address, PublicClient } from 'viem';
import { blackjackAbi } from '@/lib/blackjackAbi';

/** Headroom for wallet gas on top of the ETH sent with buyChips. */
const BUY_GAS_BUFFER_WEI = 500_000_000_000_000n;

export async function readWithdrawableChips(
  publicClient: PublicClient,
  contractAddress: Address,
  player: Address
): Promise<bigint> {
  return publicClient.readContract({
    address: contractAddress,
    abi: blackjackAbi,
    functionName: 'withdrawableChips',
    args: [player]
  });
}

export async function validateBuyChipsPreflight(
  publicClient: PublicClient,
  contractAddress: Address,
  player: Address,
  weiAmount: bigint,
  playerTableId: bigint | undefined
): Promise<string | null> {
  if (playerTableId && playerTableId !== 0n) {
    return 'Leave your current table or cash out before buying chips.';
  }

  const chips = await publicClient.readContract({
    address: contractAddress,
    abi: blackjackAbi,
    functionName: 'ethToChips',
    args: [weiAmount]
  });
  if (chips === 0n) {
    return 'That ETH amount is too small to buy chips. Try a slightly larger amount.';
  }

  const balance = await publicClient.getBalance({ address: player });
  if (balance < weiAmount + BUY_GAS_BUFFER_WEI) {
    return 'Your wallet needs more Sepolia ETH to cover the purchase and network fees.';
  }

  return null;
}

export async function validateWithdrawChipsPreflight(
  publicClient: PublicClient,
  contractAddress: Address,
  player: Address,
  chipAmount: bigint,
  playerTableId: bigint | undefined,
  walletChips: bigint | undefined
): Promise<string | null> {
  if (playerTableId && playerTableId !== 0n) {
    return 'Leave your current table or cash out before withdrawing.';
  }
  if (walletChips !== undefined && chipAmount > walletChips) {
    return 'Not enough chips in your wallet.';
  }

  const withdrawable = await readWithdrawableChips(publicClient, contractAddress, player);
  if (chipAmount > withdrawable) {
    if (withdrawable === 0n) {
      return 'Only chips purchased with ETH can be withdrawn. Free promo chips stay in your wallet for play.';
    }
    return `You can withdraw at most ${withdrawable.toString()} chips (only ETH-purchased chips are withdrawable).`;
  }

  const weiNeeded = await publicClient.readContract({
    address: contractAddress,
    abi: blackjackAbi,
    functionName: 'chipsToWei',
    args: [chipAmount]
  });
  const contractBalance = await publicClient.getBalance({ address: contractAddress });
  if (contractBalance < weiNeeded) {
    return 'Withdrawals are temporarily limited — the house bank is low on ETH. Try a smaller amount or check back later.';
  }

  return null;
}