import { useEffect, useRef } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useBankHealth } from '@/hooks/useBankHealth';
import { formatChips } from '@/utils/contractMapping';
import { toast } from '@/lib/toast';

export const BankHealthBanner = () => {
  const { isLow, chipsFloat, ethBackedChips, solvent, isLoading } = useBankHealth();
  const warnedRef = useRef(false);

  useEffect(() => {
    if (isLoading || !isLow || warnedRef.current) return;
    warnedRef.current = true;
    toast.warning('Dealer bank is underfunded', {
      description: `Bank float ${formatChips(chipsFloat)} chips vs ${formatChips(ethBackedChips)} ETH-backed. Payouts may revert until the owner funds the bank.`
    });
  }, [isLoading, isLow, chipsFloat, ethBackedChips]);

  if (isLoading || !isLow) {
    return null;
  }

  return (
    <div className="flex items-center gap-2 rounded-xl border border-amber-400/40 bg-amber-500/10 px-4 py-2 text-xs text-amber-100">
      <AlertTriangle className="h-4 w-4 shrink-0 text-amber-300" />
      <span>
        Dealer bank {solvent ? 'is tight' : 'is insolvent'} — float {formatChips(chipsFloat)} chips, ETH-backed{' '}
        {formatChips(ethBackedChips)}. Owner should call <code className="text-amber-50">fundBank</code> before large wins.
      </span>
    </div>
  );
};