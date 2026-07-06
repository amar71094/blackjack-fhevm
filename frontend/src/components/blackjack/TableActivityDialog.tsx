import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog';
import { formatChips } from '@/utils/contractMapping';
import type { TableActivityHand } from '@/lib/tableActivityStore';
import { MAX_TABLE_ACTIVITY_HANDS } from '@/lib/tableActivityStore';

interface TableActivityDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tableId: bigint;
  activity: TableActivityHand[];
  addressToName: Map<string, string>;
}

const shortenAddress = (address: string): string =>
  address.length >= 10 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;

const formatHandTime = (timestamp: number): string => {
  const date = new Date(timestamp * 1_000);
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
};

export const TableActivityDialog = ({
  open,
  onOpenChange,
  tableId,
  activity,
  addressToName
}: TableActivityDialogProps) => (
  <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="max-h-[80vh] max-w-md overflow-hidden border-primary/20 bg-slate-950 text-slate-100">
      <DialogHeader>
        <DialogTitle className="text-base uppercase tracking-[0.28em] text-primary">
          Table Activity
        </DialogTitle>
        <DialogDescription className="text-xs text-slate-400">
          Table #{tableId.toString()} — last {MAX_TABLE_ACTIVITY_HANDS} completed hands
        </DialogDescription>
      </DialogHeader>

      <div className="max-h-[55vh] space-y-2 overflow-y-auto pr-1">
        {activity.length === 0 ? (
          <p className="rounded-lg border border-dashed border-white/10 px-4 py-6 text-center text-xs uppercase tracking-[0.2em] text-slate-500">
            No completed hands for this table yet.
          </p>
        ) : (
          activity.map((hand) => (
            <div
              key={hand.timestamp}
              className="rounded-xl border border-white/10 bg-black/35 px-3 py-2.5"
            >
              <div className="mb-1.5 flex items-center justify-between text-[0.62rem] uppercase tracking-[0.22em] text-slate-400">
                <span>{formatHandTime(hand.timestamp)}</span>
                <span>Pot {formatChips(hand.pot)}</span>
              </div>
              {hand.dealerWon ? (
                <p className="text-xs font-medium text-rose-300">Dealer won</p>
              ) : (
                <ul className="space-y-1">
                  {hand.winners.map((winner) => {
                    const name =
                      addressToName.get(winner.address.toLowerCase()) ??
                      shortenAddress(winner.address);
                    return (
                      <li
                        key={`${hand.timestamp}-${winner.address}`}
                        className="flex items-center justify-between text-xs"
                      >
                        <span className="font-medium text-emerald-200">{name}</span>
                        <span className="text-emerald-300/90">+{formatChips(winner.payout)}</span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          ))
        )}
      </div>
    </DialogContent>
  </Dialog>
);