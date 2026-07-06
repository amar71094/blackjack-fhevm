import { ContractOutcome, type ContractHandResult } from '@/types/blackjackContract';

export const MAX_TABLE_ACTIVITY_HANDS = 100;

export interface TableActivityWinner {
  address: string;
  payout: number;
}

export interface TableActivityHand {
  timestamp: number;
  pot: number;
  dealerWon: boolean;
  winners: TableActivityWinner[];
  txHash?: string;
}

/** Prepend the latest on-chain hand when the activity API has not caught up yet. */
export const mergeLatestHandActivity = (
  activity: TableActivityHand[],
  hand: ContractHandResult | null | undefined
): TableActivityHand[] => {
  if (!hand || hand.timestamp === 0n) return activity;

  const timestamp = Number(hand.timestamp);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return activity;
  if (activity.some((entry) => entry.timestamp === timestamp)) return activity;

  const winners = hand.results
    .filter(
      (result) =>
        result.payout > 0n &&
        (result.outcome === ContractOutcome.Win || result.outcome === ContractOutcome.Blackjack)
    )
    .map((result) => ({
      address: result.addr.toLowerCase(),
      payout: Number(result.payout)
    }));

  const latest: TableActivityHand = {
    timestamp,
    pot: Number(hand.pot),
    dealerWon: winners.length === 0,
    winners
  };

  return [latest, ...activity]
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, MAX_TABLE_ACTIVITY_HANDS);
};