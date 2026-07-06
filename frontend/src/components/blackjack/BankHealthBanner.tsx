import { useEffect, useRef } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useBankHealth } from '@/hooks/useBankHealth';
import { toast } from '@/lib/toast';

export const BankHealthBanner = () => {
  const { isLow, solvent, isLoading } = useBankHealth();
  const warnedRef = useRef(false);

  useEffect(() => {
    if (isLoading || !isLow || warnedRef.current) return;
    warnedRef.current = true;
    toast.warning('Payouts may be delayed', {
      description: 'The house bank is running low. Large wins may take longer to pay out until reserves are restored.'
    });
  }, [isLoading, isLow]);

  if (isLoading || !isLow) {
    return null;
  }

  return (
    <div className="flex items-center gap-2 rounded-xl border border-amber-400/40 bg-amber-500/10 px-4 py-2 text-xs text-amber-100">
      <AlertTriangle className="h-4 w-4 shrink-0 text-amber-300" />
      <span>
        {solvent
          ? 'The house bank is running low — large wins may take longer to pay out.'
          : 'The house bank is critically low — payouts may be delayed until reserves are restored.'}
      </span>
    </div>
  );
};