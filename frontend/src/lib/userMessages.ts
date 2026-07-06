import { friendlyRevertMessage } from '@/lib/contractWrite';

const ACTION_ERROR_TITLES: Record<string, string> = {
  claimFreeChips: 'Could not claim free chips',
  buyChips: 'Could not buy chips',
  withdrawChips: 'Could not withdraw chips',
  createTable: 'Could not create table',
  joinTable: 'Could not join table',
  leaveTable: 'Could not leave table',
  cashOut: 'Could not cash out',
  topUpTableChips: 'Could not top up',
  placeBet: 'Could not place bet',
  hit: 'Could not hit',
  stand: 'Could not stand',
  doubleDown: 'Could not double down',
  forceAdvanceOnTimeout: 'Could not advance the table'
};

export function getActionErrorTitle(functionName: string): string {
  return ACTION_ERROR_TITLES[functionName] ?? 'That action could not be completed';
}

export function extractErrorMessage(error: unknown): string {
  return (
    (error as { shortMessage?: string })?.shortMessage ??
    (error as { cause?: { shortMessage?: string } })?.cause?.shortMessage ??
    (error as Error)?.message ??
    String(error)
  );
}

/** Full technical detail for the browser console — never shown in UI. */
export function logTechnicalError(context: string, error: unknown, extra?: Record<string, unknown>): void {
  console.error(`[CipherJack] ${context}`, {
    error,
    message: extractErrorMessage(error),
    ...extra
  });
}

export function describeUserFacingError(error: unknown): string {
  const friendly = friendlyRevertMessage(error);
  if (friendly) return friendly;
  return 'Something went wrong. Try again, or reconnect your wallet if the problem continues.';
}

export function shortenTxHash(hash: string): string {
  return hash.length >= 10 ? `${hash.slice(0, 6)}…${hash.slice(-4)}` : hash;
}

export function describeWalletConnectError(error: unknown): string {
  const message = extractErrorMessage(error);
  if (/rejected|denied|cancel/i.test(message)) {
    return 'Connection was cancelled.';
  }
  if (/pending|already/i.test(message)) {
    return 'A connection request is already open in your wallet.';
  }
  return 'Could not connect your wallet. Try again or use a different provider.';
}

export function describeNetworkSwitchError(error: unknown): string {
  const message = extractErrorMessage(error);
  if (/rejected|denied|cancel/i.test(message)) {
    return 'Network switch was cancelled.';
  }
  return 'Could not switch networks. Change the network manually in your wallet.';
}

export const TABLE_STATUS = {
  confirmingBust: 'Confirming bust',
  processing: 'Processing',
  dealingHand: 'Dealing hand',
  dealer: 'Dealer',
  confirmingBustBanner: 'Confirming Bust',
  processingBanner: 'Processing',
  dealingHandBanner: 'Dealing Hand',
  dealerPlayingBanner: 'Dealer Playing',
  pleaseWaitBanner: 'Please Wait',
  bustConfirmed: 'Bust Confirmed',
  waitingOnAction: 'Please Wait',
  processingAction: 'Processing'
} as const;

export function waitingOnPlayerLabel(playerName: string): string {
  return `Waiting on ${playerName}`;
}

export function tableProcessingHelperMessage(params: {
  confirmingBust: boolean;
  dealingHand: boolean;
  dealerPlaying: boolean;
  settling: boolean;
  processingForSelf: boolean;
  otherPlayerName?: string | null;
}): string {
  const { confirmingBust, dealingHand, dealerPlaying, settling, processingForSelf, otherPlayerName } =
    params;

  if (confirmingBust) {
    return 'Confirming your bust. The next player can act once this finishes.';
  }
  if (dealingHand) {
    return 'Dealing the hand. Your cards appear once the table is ready.';
  }
  if (dealerPlaying) {
    return 'The dealer is playing. Cards reveal once this step finishes.';
  }
  if (settling) {
    return 'Settling the hand. Results appear once this step finishes.';
  }
  if (processingForSelf) {
    return 'Your last action is being processed. Hit, stand, and double unlock when it finishes.';
  }
  if (otherPlayerName) {
    return `Waiting for ${otherPlayerName} to finish. Play controls unlock when their action completes.`;
  }
  return 'The table is processing the current action. Play controls unlock when it finishes.';
}