import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { Hand, PauseCircle, Swords } from 'lucide-react';

type StatusVariant = 'active' | 'waiting' | 'locked' | 'idle';

interface ControlStatus {
  label: string;
  variant: StatusVariant;
}

interface PlayControlPanelProps {
  betInput: string;
  onBetChange: (value: string) => void;
  onPlaceBet: () => void;
  disableActions: boolean;
  isSeated: boolean;
  gamePhase?: string;
  connectedCanAct: boolean;
  canDouble: boolean;
  onHit: () => void;
  onStand: () => void;
  onDouble: () => void;
  isPending: boolean;
  availableChips?: string;
  minBet?: string;
  status: ControlStatus;
  helperMessage?: string;
  className?: string;
}

const statusStyles: Record<StatusVariant, string> = {
  active: 'border-emerald-400/60 bg-emerald-500/10 text-emerald-200',
  waiting: 'border-amber-300/50 bg-amber-400/15 text-amber-200',
  locked: 'border-white/15 bg-white/5 text-white/60',
  idle: 'border-sky-400/50 bg-sky-500/10 text-sky-200'
};

const actionButtonBase =
  'flex items-center justify-center gap-2 rounded-xl border border-transparent px-4 py-2.5 text-[0.62rem] font-semibold uppercase tracking-[0.22em] transition-all disabled:pointer-events-none disabled:opacity-40';

export const PlayControlPanel = ({
  betInput,
  onBetChange,
  onPlaceBet,
  disableActions,
  isSeated,
  gamePhase,
  connectedCanAct,
  canDouble,
  onHit,
  onStand,
  onDouble,
  isPending,
  availableChips,
  minBet,
  status,
  helperMessage,
  className
}: PlayControlPanelProps) => {
  const bettingLocked = disableActions || isPending || !isSeated || gamePhase !== 'betting';

  return (
    <div
      className={cn(
        'w-full rounded-2xl border border-white/10 bg-gradient-to-br from-black/85 via-slate-950/70 to-black/75 px-3 py-4 text-[0.68rem] text-white shadow-[0_20px_48px_-36px_rgba(0,0,0,0.85)] backdrop-blur-md sm:px-5',
        className
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2 text-[0.58rem] uppercase tracking-[0.28em] text-white/60">
          <span className="text-white/75">Play Controls</span>
          {minBet && (
            <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-white/70">Min {minBet}</span>
          )}
          {availableChips && (
            <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-white/70">Stack {availableChips}</span>
          )}
        </div>
        <span
          className={cn(
            'rounded-full border px-3 py-1 text-[0.55rem] font-semibold uppercase tracking-[0.3em] shadow-sm backdrop-blur',
            statusStyles[status.variant]
          )}
        >
          {status.label}
        </span>
      </div>

      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex w-full flex-1 items-center gap-2 sm:max-w-sm">
          <div className="flex w-full items-center gap-2 rounded-xl border border-white/10 bg-black/45 px-3 py-1.5">
            <Input
              value={betInput}
              onChange={(event) => onBetChange(event.target.value)}
              placeholder="Enter wager"
              type="number"
              min={0}
              className="h-9 flex-1 rounded-lg border-none bg-transparent text-[0.74rem] font-medium text-white placeholder:text-white/40 focus-visible:ring-0"
              disabled={bettingLocked}
            />
            <Button
              onClick={onPlaceBet}
              disabled={bettingLocked}
              className="h-9 rounded-lg bg-gradient-to-br from-amber-300 via-amber-400 to-amber-500 px-4 text-[0.6rem] font-semibold uppercase tracking-[0.3em] text-slate-950 shadow-[0_14px_28px_-20px_rgba(245,158,11,0.8)] hover:from-amber-200 hover:via-amber-300 hover:to-amber-500"
            >
              Bet
            </Button>
          </div>
        </div>

        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:justify-end">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                onClick={onHit}
                disabled={!connectedCanAct || disableActions || isPending}
                className={cn(
                  actionButtonBase,
                  'bg-gradient-to-br from-emerald-400 via-emerald-500/90 to-emerald-400/85 text-slate-950 shadow-[0_16px_30px_-20px_rgba(16,185,129,0.75)] hover:from-emerald-300 hover:to-emerald-500'
                )}
              >
                <Hand className="h-4 w-4" /> Hit
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">Draw another encrypted card.</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                onClick={onStand}
                disabled={!connectedCanAct || disableActions || isPending}
                className={cn(
                  actionButtonBase,
                  'border-white/20 bg-white/5 text-white hover:border-amber-200/60 hover:bg-white/10'
                )}
              >
                <PauseCircle className="h-4 w-4" /> Stand
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">Lock in your current total and end your turn.</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                onClick={onDouble}
                disabled={!canDouble || disableActions || isPending}
                className={cn(
                  actionButtonBase,
                  'bg-gradient-to-br from-indigo-500 via-indigo-500/90 to-indigo-400 text-white shadow-[0_16px_30px_-20px_rgba(99,102,241,0.8)] hover:from-indigo-400 hover:to-indigo-500'
                )}
              >
                <Swords className="h-4 w-4" /> Double
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">Double your wager and take exactly one more card.</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {!isSeated && (
        <p className="mt-2 text-[0.56rem] uppercase tracking-[0.34em] text-amber-200/80">
          Take a seat and place a buy-in to unlock betting.
        </p>
      )}
      {helperMessage && (
        <p className="mt-2 text-[0.56rem] uppercase tracking-[0.34em] text-amber-200/85">
          {helperMessage}
        </p>
      )}
      {!helperMessage && bettingLocked && isSeated && gamePhase !== 'betting' && (
        <p className="mt-2 text-[0.56rem] uppercase tracking-[0.34em] text-white/55">
          Betting opens at the start of the next hand.
        </p>
      )}
    </div>
  );
};
