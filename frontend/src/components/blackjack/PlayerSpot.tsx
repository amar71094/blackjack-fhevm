import { Player } from '@/types/blackjack';
import { Card } from './Card';
import { calculateHandValue, resolvePlayerBust, toHiddenCard } from '@/utils/contractMapping';
import playerAvatar from '@/assets/player-ghost.png';
import { cn } from '@/lib/utils';
import { seatTurnLabel } from '@/lib/userMessages';
import { ChipStack, ChipMotion } from './ChipStack';
import { RotateCcw } from 'lucide-react';

export type PlayerDecryptState = 'idle' | 'pending' | 'success' | 'error';

// Describes the player seat rendering requirements for any given state.
interface PlayerSpotProps {
  player?: Player;
  isActive?: boolean;
  showCards?: boolean;
  phase?: 'betting' | 'dealing' | 'player-turn' | 'dealer-turn' | 'showdown' | 'waiting';
  roundActive?: boolean;
  isWinner?: boolean;
  dealerWins?: boolean;
  decryptState?: PlayerDecryptState;
  onRetryDecrypt?: () => void;
  isConnected?: boolean;
  decryptedHand?: { cards: Card[]; total: number };
  seatBanner?: { show: boolean; label: string };
}

const resultStyles: Record<Exclude<Player['result'], null>, { label: string; className: string }> = {
  blackjack: { label: 'Blackjack!', className: 'bg-emerald-500/90 text-emerald-50' },
  win: { label: 'Winner', className: 'bg-emerald-500/80 text-emerald-50' },
  push: { label: 'Push', className: 'bg-sky-500/80 text-sky-50' },
  lose: { label: 'Lost', className: 'bg-rose-500/80 text-rose-50' },
  bust: { label: 'Bust', className: 'bg-rose-600/80 text-rose-50' }
};

// Seat component: cards, chip stack, status badges, and result ribbons.
export const PlayerSpot = ({
  player,
  isActive,
  showCards = true,
  phase = 'waiting',
  roundActive = false,
  isWinner = false,
  dealerWins = false,
  decryptState,
  onRetryDecrypt,
  isConnected = false,
  decryptedHand,
  seatBanner
}: PlayerSpotProps) => {
  if (!player) {
    return (
      <div className="flex flex-col items-center gap-2">
        <div className="w-24 h-24 rounded-full bg-secondary/30 border-2 border-dashed border-muted flex items-center justify-center">
          <span className="text-muted-foreground text-sm">Empty Seat</span>
        </div>
      </div>
    );
  }

  const baseHandLength = player.hand.length;
  let renderedHand = player.displayHand;
  let renderedTotal = player.displayTotal;
  let renderedCardsRevealed = player.cardsRevealed;

  if (isConnected && decryptedHand) {
    const cloned = decryptedHand.cards.map((card, index) => ({
      ...card,
      id: `${player.id}-decrypted-${index}-${card.id}`
    }));
    if (cloned.length >= baseHandLength) {
      renderedHand = cloned;
      renderedTotal = decryptedHand.total;
      renderedCardsRevealed = true;
    } else {
      const padded = [...cloned];
      for (let index = cloned.length; index < baseHandLength; index++) {
        padded.push(toHiddenCard(index, `${player.id}-pending`));
      }
      renderedHand = padded;
      renderedTotal = null;
      renderedCardsRevealed = false;
    }
  }

  const effectiveDecryptState = decryptedHand ? 'success' : decryptState;
  const revealedTotal = renderedCardsRevealed
    ? renderedTotal ?? calculateHandValue(renderedHand)
    : null;
  const isBusted = resolvePlayerBust(player, revealedTotal, {
    cardsFullyRevealed: renderedCardsRevealed,
    requireRevealedCards: isConnected
  });
  const totalDisplay = revealedTotal ?? '??';
  const resultInfo = renderedCardsRevealed && player.result ? resultStyles[player.result] : null;
  const showDecryptNotice =
    effectiveDecryptState && effectiveDecryptState !== 'idle' && !renderedCardsRevealed;
  const decryptText =
    effectiveDecryptState === 'pending'
      ? 'Decrypting…'
      : effectiveDecryptState === 'error'
        ? 'Decryption failed'
        : null;
  const shouldRenderHand =
    (showCards || renderedCardsRevealed || (isConnected && decryptedHand)) && renderedHand.length > 0;

  let chipMotion: ChipMotion = 'idle';
  if (roundActive && phase === 'player-turn') {
    chipMotion = 'toPot';
  } else if (phase === 'showdown') {
    chipMotion = isWinner ? 'return' : dealerWins ? 'idle' : 'idle';
  }

  const fallbackTurnBanner = {
    show: Boolean(isActive && phase === 'player-turn' && !isBusted),
    label: seatTurnLabel(isConnected, player.name)
  };
  const { show: showTurnBanner, label: turnLabel } = seatBanner ?? fallbackTurnBanner;

  return (
    <div
      className={cn(
        'relative flex flex-col items-center gap-3 rounded-3xl border border-primary/25 bg-black/35 p-3 shadow-lg backdrop-blur transition-all',
        isActive && 'border-primary/70 shadow-primary/40 scale-[1.03]'
      )}
    >
      {showTurnBanner && (
        <div className="absolute -top-4 left-1/2 z-10 -translate-x-1/2">
          <div className="rounded-full bg-gradient-to-r from-amber-300 via-primary to-amber-400 px-4 py-1 text-[0.55rem] font-bold uppercase tracking-[0.35em] text-slate-950 shadow-lg">
            {turnLabel}
          </div>
        </div>
      )}
      <div className="relative z-20 flex w-full items-center justify-between gap-3">
        <div className={cn('relative h-16 w-16 shrink-0', isBusted && 'opacity-60')}>
          <div className="h-full w-full overflow-hidden rounded-full border-4 border-primary/40 bg-background/40 shadow-inner">
            <img
              src={playerAvatar}
              alt={player.name}
              className="h-full w-full object-cover"
            />
          </div>
          {player.blackjack && (
            <div className="absolute -top-2 -right-2 z-30 flex h-8 w-8 items-center justify-center rounded-full bg-primary text-xs font-black text-primary-foreground shadow-lg">
              BJ
            </div>
          )}
        </div>
        <div className="flex flex-1 flex-col text-right">
          <span className="text-sm font-semibold uppercase tracking-wider text-muted-foreground/80">{player.name}</span>
          <span className="text-[0.6rem] font-semibold uppercase tracking-[0.35em] text-muted-foreground/60">Bank</span>
          <span className="text-base font-black text-primary">{player.chips}</span>
          {player.bet > 0 && (
            <span className="text-xs font-semibold uppercase tracking-widest text-muted-foreground/80">Stake: {player.bet}</span>
          )}
        </div>
      </div>

      {player.bet > 0 && (
        <div className="relative flex min-h-[28px] w-full items-center justify-center overflow-visible">
          <ChipStack amount={player.bet} size="sm" motion={chipMotion} />
        </div>
      )}

      {shouldRenderHand && (
        <div className="flex w-full flex-col items-center gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-1 justify-center sm:justify-start">
            <div className="rounded-2xl border border-primary/20 bg-secondary/25 px-3 py-2 shadow-inner">
              <div className="flex items-center">
                {renderedHand.map((card, index) => (
                  <div
                    key={card.id ?? `${player.id}-card-${index}`}
                    className={cn('transition-transform', index > 0 && '-ml-5')}
                    style={{ zIndex: index + 1 }}
                  >
                    <Card card={card} size="sm" faceUp={card.suit !== '??'} />
                  </div>
                ))}
              </div>
            </div>
          </div>
         <div
           className={cn(
             'rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-[0.35em] shadow',
             renderedCardsRevealed
               ? isBusted
                 ? 'bg-rose-600/90 text-rose-50'
                 : player.blackjack
                   ? 'bg-emerald-500/90 text-emerald-50'
                   : 'bg-primary/80 text-primary-foreground'
               : 'bg-muted/60 text-muted-foreground/80'
           )}
         >
           {renderedCardsRevealed
             ? isBusted
               ? `Bust! (${totalDisplay})`
               : `Total ${totalDisplay}`
             : 'Encrypted Hand'}
         </div>
       </div>
      )}

      {!renderedCardsRevealed && isBusted && (
        <div className="rounded-full border border-rose-400/40 bg-rose-600/80 px-3 py-1 text-[0.65rem] font-semibold uppercase tracking-[0.32em] text-rose-50">
          Bust!
        </div>
      )}

      {showDecryptNotice && decryptText && (
        <div className="flex flex-col items-center gap-2">
          <div className="rounded-full border border-primary/30 bg-black/60 px-3 py-1 text-[0.65rem] font-semibold uppercase tracking-[0.32em] text-primary/80">
            {decryptText}
          </div>
          {effectiveDecryptState === 'error' && onRetryDecrypt && (
            <button
              type="button"
              onClick={onRetryDecrypt}
              className="flex items-center gap-2 rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-[0.6rem] font-semibold uppercase tracking-[0.28em] text-primary hover:bg-primary/20"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Retry
            </button>
          )}
        </div>
      )}

      {renderedCardsRevealed && (isBusted || resultInfo) && (
        <div
          className={cn(
            'absolute -top-3 left-1/2 -translate-x-1/2 rounded-full px-4 py-1 text-xs font-semibold uppercase tracking-widest shadow-lg',
            isBusted
              ? 'bg-rose-600/95 text-rose-50'
              : resultInfo?.className
          )}
        >
          {isBusted ? 'Bust!' : resultInfo?.label}
        </div>
      )}
    </div>
  );
};
