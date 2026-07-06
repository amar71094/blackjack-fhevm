import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { WalletControls, WalletPanelConfig } from '@/components/wallet/WalletControls';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog';
import { GameRulesButton } from '@/components/blackjack/GameRulesButton';
import logo from '@/assets/cipherjack-logo.jpeg';

interface SiteHeaderProps {
  playerTableId?: bigint;
  tablePhase?: string;
  walletPanel?: WalletPanelConfig;
}

// Minimal sticky header with brand, table context, and wallet quick actions.
export const SiteHeader = ({ playerTableId, tablePhase, walletPanel }: SiteHeaderProps) => {
  const [isClaiming, setIsClaiming] = useState(false);
  const [showClaimDialog, setShowClaimDialog] = useState(false);
  const [claimedOverride, setClaimedOverride] = useState(false);

  const handleClaimClick = async () => {
    if (!walletPanel?.onClaimFreeChips) return;
    setIsClaiming(true);
    const success = await walletPanel.onClaimFreeChips();
    if (success) {
      setClaimedOverride(true);
      setShowClaimDialog(false);
    }
    setIsClaiming(false);
  };

  useEffect(() => {
    if (!walletPanel) {
      setShowClaimDialog(false);
      setClaimedOverride(false);
      return;
    }
    if (walletPanel.hasClaimedFreeChips === false && walletPanel.onClaimFreeChips && !claimedOverride) {
      setShowClaimDialog(true);
    } else if (walletPanel.hasClaimedFreeChips || claimedOverride) {
      setShowClaimDialog(false);
    }
  }, [walletPanel, claimedOverride]);

  const mergedPanel = useMemo<WalletPanelConfig | undefined>(() => {
    if (!walletPanel) return undefined;
    return {
      ...walletPanel,
      pending: Boolean(walletPanel.pending || isClaiming),
      hasClaimedFreeChips: (walletPanel.hasClaimedFreeChips ?? false) || claimedOverride
    };
  }, [walletPanel, isClaiming, claimedOverride]);

  const disableWalletActions = useMemo(
    () => Boolean(mergedPanel?.pending),
    [mergedPanel?.pending]
  );

  return (
    <header className="sticky top-0 z-40 border-b border-white/10 bg-slate-950/90 backdrop-blur">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-3 px-4 py-3 sm:px-6 lg:px-8">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-4">
            <Link to="/" className="flex items-center gap-3">
              <div className="h-10 w-10 overflow-hidden rounded-xl border border-primary/50 shadow">
                <img src={logo} alt="CipherJack" className="h-full w-full object-cover" />
              </div>
              <div className="flex flex-col">
                <span className="text-[0.65rem] uppercase tracking-[0.45em] text-primary/70">CipherJack</span>
                <span className="text-base font-semibold text-white">Private Blackjack</span>
              </div>
            </Link>
            {playerTableId && (
              <Badge variant="outline" className="border-primary/50 bg-primary/10 text-primary">
                Table #{playerTableId.toString()}
                {tablePhase ? ` • ${tablePhase.replace(/-/g, ' ').toUpperCase()}` : ''}
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-3">
            <GameRulesButton />
            <WalletControls panel={mergedPanel} />
          </div>
        </div>

        {walletPanel && walletPanel.onClaimFreeChips && (
          <Dialog open={showClaimDialog} onOpenChange={setShowClaimDialog}>
            <DialogContent className="bg-slate-950/95 text-white backdrop-blur">
              <DialogHeader>
                <DialogTitle>Claim Your Starter Chips</DialogTitle>
                <DialogDescription className="text-white/70">
                  Grab a complimentary stack of chips to join the action instantly.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter className="flex flex-col gap-2 sm:flex-row sm:justify-end">
                <Button
                  variant="secondary"
                  onClick={() => setShowClaimDialog(false)}
                  className="sm:w-auto"
                >
                  Maybe Later
                </Button>
                <Button
                  onClick={handleClaimClick}
                  className="sm:w-auto"
                  disabled={((walletPanel.hasClaimedFreeChips ?? false) || claimedOverride) || disableWalletActions}
                >
                  {isClaiming ? 'Claiming…' : 'Claim Free Chips'}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        )}
      </div>
    </header>
  );
};
