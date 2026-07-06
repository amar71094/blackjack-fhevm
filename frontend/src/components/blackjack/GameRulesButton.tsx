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
        <DialogContent className="max-w-lg border border-primary/40 bg-slate-950/95 text-white">
          <DialogHeader>
            <DialogTitle>How CipherJack Works</DialogTitle>
            <DialogDescription className="text-white/70">
              Classic blackjack with private hands — only you can see your cards until the showdown.
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
                <li>Place your wager during the betting phase, then two cards are dealt to each active player and the dealer.</li>
                <li>On your turn choose <strong>Hit</strong> for another card, <strong>Stand</strong> to hold, or <strong>Double</strong> to double your bet and take one final card.</li>
                <li>If you run out of time on your turn, the table will stand for you automatically.</li>
                <li>If you exceed 21 your hand busts and the bet is forfeited.</li>
              </ul>
            </div>
            <div>
              <h4 className="font-semibold text-white">Dealer Rules</h4>
              <ul className="list-disc space-y-2 pl-5">
                <li>The dealer hits until reaching a hard 17 or higher and must hit on soft 17.</li>
                <li>Dealer cards stay hidden until all player turns finish, then they are revealed for the showdown.</li>
              </ul>
            </div>
            <div>
              <h4 className="font-semibold text-white">Payouts</h4>
              <ul className="list-disc space-y-2 pl-5">
                <li>Wins pay 1:1, blackjacks pay 3:2, and pushes return the original bet.</li>
                <li>All wagers and payouts are settled automatically once the hand is complete.</li>
              </ul>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
};

export default GameRulesButton;