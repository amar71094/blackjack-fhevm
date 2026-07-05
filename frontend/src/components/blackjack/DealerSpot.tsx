import { Dealer } from '@/types/blackjack';
import { Card } from './Card';
import { calculateHandValue } from '@/utils/contractMapping';
import dealerGhost from '@/assets/dealer-ghost.png';
import { cn } from '@/lib/utils';
import { ChipStack } from './ChipStack';
import type { PlayerDecryptState } from './PlayerSpot';
import { RotateCcw } from 'lucide-react';

// Props describing the dealer section regardless of hand state.
interface DealerSpotProps {
  dealer: Dealer;
  hideSecondCard?: boolean;
  dealerWins?: boolean;
  potAmount?: number;
  visibleCount?: number;
  awaitingReveal?: boolean;
  decryptState?: PlayerDecryptState;
  onRetryDecrypt?: () => void;
}

// Renders the dealer avatar, cards, and current status/bust callout.
export const DealerSpot = ({ dealer, hideSecondCard, dealerWins, potAmount = 0, visibleCount, awaitingReveal = false, decryptState = 'idle', onRetryDecrypt }: DealerSpotProps) => {
  const cardsRevealed = dealer.cardsRevealed && !hideSecondCard;
  const safeVisibleCount = visibleCount === undefined
    ? dealer.displayHand.length
    : Math.max(0, Math.min(visibleCount, dealer.displayHand.length));

  const cardsToShow = dealer.displayHand.slice(0, safeVisibleCount);
  const revealedTotal = cardsRevealed
    ? dealer.displayTotal ?? calculateHandValue(dealer.hand)
    : null;
  const totalDisplay = revealedTotal ?? '??';
  const statusLabel = cardsRevealed
    ? dealer.bust
      ? `Bust! (${totalDisplay})`
      : dealer.blackjack
        ? 'Blackjack'
        : `Total ${totalDisplay}`
    : null;
  const decryptMessage =
    !cardsRevealed && decryptState === 'pending'
      ? 'Decrypting…'
      : !cardsRevealed && decryptState === 'error'
        ? 'Reveal delayed'
        : null;

  return (
    <div className="flex flex-col gap-3 rounded-3xl border border-primary/30 bg-black/40 px-6 py-4 shadow-xl backdrop-blur">
      <div className="flex flex-col items-center gap-3 sm:flex-row sm:items-center sm:gap-6">
        <div className={cn(
          'relative h-28 w-28 overflow-hidden rounded-full border-4 border-primary/50 bg-background/50 shadow-lg',
          dealer.bust && cardsRevealed && 'opacity-60'
        )}>
          <img
            src={dealerGhost}
            alt="Dealer"
            className="h-full w-full object-contain"
          />
          {cardsRevealed && dealer.blackjack && (
            <div className="absolute -top-2 -right-2 flex h-9 w-9 items-center justify-center rounded-full bg-primary text-sm font-black text-primary-foreground">
              BJ
            </div>
          )}
        </div>

        <div className="flex flex-col items-center gap-3 sm:items-start">
          <div className="text-center sm:text-left">
            <div className="text-xs font-semibold uppercase tracking-[0.6em] text-muted-foreground">House</div>
            <div className="text-2xl font-black text-primary">Dealer</div>
          </div>

          {cardsRevealed && dealer.bust && (
            <div className="rounded-full bg-rose-600/90 px-4 py-1 text-xs font-semibold uppercase tracking-[0.35em] text-rose-50 shadow">
              Bust!
            </div>
          )}

          {cardsToShow.length > 0 && (
            <div className="rounded-2xl border border-primary/20 bg-secondary/25 px-4 py-3 shadow-inner">
              <div className="flex justify-center gap-2 sm:justify-start">
                {cardsToShow.map((card, index) => (
                  <div key={card.id} className="relative" style={{ transform: `translateX(${index * -12}px)` }}>
                    <Card
                      card={card}
                      size="md"
                      faceUp={cardsRevealed}
                    />
                  </div>
                ))}
              </div>
            </div>
          )}

          {cardsRevealed && (
            <div
              className={cn(
                'rounded-full px-4 py-1 text-xs font-semibold uppercase tracking-[0.35em] shadow',
                dealer.bust
                  ? 'bg-rose-600/90 text-rose-50'
                  : dealer.blackjack
                    ? 'bg-emerald-500/90 text-emerald-50'
                    : 'bg-primary/85 text-primary-foreground'
              )}
            >
              {statusLabel}
            </div>
          )}

          {!cardsRevealed && awaitingReveal && (
            <div className="rounded-full border border-primary/30 bg-black/50 px-4 py-1 text-xs font-semibold uppercase tracking-[0.35em] text-primary/70 shadow">
              Awaiting Reveal
            </div>
          )}

          {!cardsRevealed && decryptMessage && (
            <div className="flex flex-col items-center gap-2">
              <div className="rounded-full border border-primary/30 bg-black/50 px-4 py-1 text-xs font-semibold uppercase tracking-[0.35em] text-primary/70 shadow">
                {decryptMessage}
              </div>
              {decryptState === 'error' && onRetryDecrypt ? (
                <button
                  type="button"
                  onClick={onRetryDecrypt}
                  className="flex items-center gap-2 rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-[0.6rem] font-semibold uppercase tracking-[0.28em] text-primary hover:bg-primary/20"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  Retry reveal
                </button>
              ) : null}
            </div>
          )}
        </div>
      </div>

      {dealerWins && potAmount > 0 && (
        <div className="flex justify-center">
          <ChipStack amount={potAmount} size="sm" motion="return" />
        </div>
      )}
    </div>
  );
};
