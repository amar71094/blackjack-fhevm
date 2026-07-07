import { useState } from 'react';
import { HelpCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog';
import {
  FREE_CHIP_GRANT,
  MAX_TABLE_PLAYERS,
  TURN_TIMEOUT_SECONDS,
  ZAMA_FHEVM_DOCS_URL
} from '@/lib/gameConstants';

export const GameRulesButton = () => {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        variant="ghost"
        className="gap-2 text-white/80 hover:text-white"
        onClick={() => setOpen(true)}
      >
        <HelpCircle className="h-4 w-4" />
        Rules
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto border border-primary/40 bg-slate-950/95 text-white">
          <DialogHeader>
            <DialogTitle>How CipherJack Works</DialogTitle>
            <DialogDescription className="text-white/70">
              Classic blackjack on Sepolia with encrypted on-chain card hands. Only your wallet can
              decrypt your cards.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 text-sm leading-relaxed text-white/80">
            <div>
              <h4 className="font-semibold text-white">Objective</h4>
              <p>Beat the dealer by getting as close to 21 as possible without busting.</p>
            </div>
            <div>
              <h4 className="font-semibold text-white">Turn Flow</h4>
              <ul className="list-disc space-y-2 pl-5">
                <li>
                  Place your wager during the betting phase, then two cards are dealt to each active
                  player and the dealer.
                </li>
                <li>
                  On your turn choose <strong>Hit</strong> for another card, <strong>Stand</strong>{' '}
                  to hold, or <strong>Double</strong> to double your bet and take one final card (only
                  on your first two cards).
                </li>
                <li>
                  If you run out of time on your turn ({TURN_TIMEOUT_SECONDS} seconds), the table will
                  stand for you automatically.
                </li>
                <li>If you exceed 21 your hand busts and the bet is forfeited.</li>
                <li>Up to {MAX_TABLE_PLAYERS} players per table. Top up your stack between hands only.</li>
              </ul>
            </div>
            <div>
              <h4 className="font-semibold text-white">Dealer Rules</h4>
              <ul className="list-disc space-y-2 pl-5">
                <li>
                  The dealer hits on 16 or less and stands on 17 or more (including soft 17).
                </li>
                <li>
                  Dealer cards stay encrypted until player turns finish, then they are revealed for
                  the showdown.
                </li>
              </ul>
            </div>
            <div>
              <h4 className="font-semibold text-white">Payouts</h4>
              <ul className="list-disc space-y-2 pl-5">
                <li>Wins pay 1:1, blackjacks pay 3:2, and pushes return the original bet.</li>
                <li>All wagers and payouts settle automatically on-chain once the hand is complete.</li>
              </ul>
            </div>
            <div>
              <h4 className="font-semibold text-white">Chips &amp; Wallet</h4>
              <ul className="list-disc space-y-2 pl-5">
                <li>
                  Claim {FREE_CHIP_GRANT.toLocaleString()} free promo chips once (for play only — not
                  withdrawable).
                </li>
                <li>Buy additional chips with Sepolia test ETH. Only ETH-purchased chips can be withdrawn.</li>
                <li>Leave the table to move your table stack back to your wallet between hands.</li>
              </ul>
            </div>
            <div>
              <h4 className="font-semibold text-white">Private Hands (Zama fhEVM)</h4>
              <ul className="list-disc space-y-2 pl-5">
                <li>Card ranks and suits are stored as encrypted handles on-chain.</li>
                <li>Other players and spectators see encrypted cards, not your hand values.</li>
                <li>
                  Your wallet signs a decryption request so only you can reveal your cards to yourself.
                </li>
                <li>
                  Learn more in the{' '}
                  <a
                    href={ZAMA_FHEVM_DOCS_URL}
                    target="_blank"
                    rel="noreferrer"
                    className="text-primary underline decoration-primary/40 underline-offset-2"
                  >
                    Zama fhEVM documentation
                  </a>
                  .
                </li>
              </ul>
            </div>
            <p className="text-xs text-white/50">
              Sepolia testnet — play chips only, not real money.
            </p>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
};

export default GameRulesButton;