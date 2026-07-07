import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, ShieldCheck, Zap, Cpu } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { SiteHeader } from '@/components/layout/SiteHeader';
import { useBlackjackLobby } from '@/hooks/useBlackjackLobby';
import { formatChips } from '@/utils/contractMapping';
import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { SiteFooter } from '@/components/layout/SiteFooter';
import { TestnetBanner } from '@/components/layout/TestnetBanner';
import { BankHealthBanner } from '@/components/blackjack/BankHealthBanner';
import { FREE_CHIP_GRANT, MAX_TABLE_PLAYERS } from '@/lib/gameConstants';
import { useAccount } from 'wagmi';
import { parseEther } from 'viem';

const MAX_PLAYERS = MAX_TABLE_PLAYERS;

const parseChipAmount = (value: string): bigint | null => {
  try {
    const normalized = value.trim();
    if (!normalized) return null;
    const big = BigInt(normalized);
    return big > 0n ? big : null;
  } catch {
    return null;
  }
};

const parseEthAmount = (value: string): bigint | null => {
  try {
    const normalized = value.trim();
    if (!normalized) return null;
    const wei = parseEther(normalized as `${number}`);
    return wei > 0n ? wei : null;
  } catch {
    return null;
  }
};

const LobbyFeature = ({ icon: Icon, title, description }: { icon: typeof ShieldCheck; title: string; description: string }) => (
  <div className="flex items-start gap-4 rounded-3xl border border-primary/20 bg-black/30 p-5 shadow-lg backdrop-blur">
    <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/20 text-primary">
      <Icon className="h-6 w-6" />
    </div>
    <div className="space-y-2">
      <h3 className="text-lg font-semibold text-white/95">{title}</h3>
      <p className="text-sm text-white/70">{description}</p>
    </div>
  </div>
);

const TablePill = ({ label }: { label: string }) => (
  <span className="rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-[0.7rem] font-semibold uppercase tracking-[0.4em] text-primary/80">
    {label}
  </span>
);

const TableCardSkeleton = () => (
  <Card className="border-primary/20 bg-card/40">
    <CardContent className="space-y-4 p-6">
      <div className="h-6 w-1/3 rounded bg-white/10" />
      <div className="flex gap-2">
        <div className="h-4 w-20 rounded bg-white/10" />
        <div className="h-4 w-16 rounded bg-white/10" />
      </div>
      <div className="h-10 w-full rounded bg-white/10" />
    </CardContent>
  </Card>
);

const heroBackground =
  'bg-[radial-gradient(circle_at_top,rgba(255,215,128,0.18),transparent_55%)] bg-[radial-gradient(circle_at_bottom,rgba(16,75,95,0.20),transparent_60%)]';

const Index = () => {
  const navigate = useNavigate();
  const { address } = useAccount();
  const walletConnected = Boolean(address);
  const { tables, isLoading, pendingAction, actions, playerTableId, walletChips, withdrawableChips, hasClaimedFreeChips } = useBlackjackLobby();
  const [createOpen, setCreateOpen] = useState(false);
  const [joinOpen, setJoinOpen] = useState(false);
  const [joinTableId, setJoinTableId] = useState<bigint | null>(null);
  const [joinAmount, setJoinAmount] = useState('');
  const [minBuyIn, setMinBuyIn] = useState('100');
  const [maxBuyIn, setMaxBuyIn] = useState('1000');
  const selectedTable = useMemo(
    () => tables.find((table) => joinTableId !== null && table.id === joinTableId),
    [tables, joinTableId]
  );

  const currentTable = useMemo(() => {
    if (!playerTableId) return undefined;
    return tables.find((table) => table.id === playerTableId);
  }, [playerTableId, tables]);

  const isSwitchingTable = useMemo(() => {
    if (!playerTableId || joinTableId === null) return false;
    return playerTableId !== joinTableId;
  }, [playerTableId, joinTableId]);

  const walletBalanceDisplay = useMemo(
    () => (walletChips !== undefined ? formatChips(walletChips) : undefined),
    [walletChips]
  );
  const withdrawableDisplay = useMemo(
    () => (withdrawableChips !== undefined ? formatChips(withdrawableChips) : undefined),
    [withdrawableChips]
  );
  const claimFreeChipsAction = actions.claimFreeChips;
  const buyChipsAction = actions.buyChips;
  const withdrawChipsAction = actions.withdrawChips;

  const handleBuyChips = useCallback(async (ethAmount: string) => {
    const wei = parseEthAmount(ethAmount);
    if (wei === null) {
      toast.error('Enter a valid ETH amount (e.g. 0.05).');
      return false;
    }
    return buyChipsAction(wei);
  }, [buyChipsAction]);

  const handleWithdrawChips = useCallback(async (rawAmount: string) => {
    const amount = parseChipAmount(rawAmount);
    if (amount === null) {
      toast.error('Enter a valid chip amount.');
      return false;
    }
    return withdrawChipsAction(amount);
  }, [withdrawChipsAction]);

  const headerWalletPanel = useMemo(() => (
    {
      walletBalance: walletBalanceDisplay,
      withdrawableBalance: withdrawableDisplay,
      pending: pendingAction !== null,
      onClaimFreeChips: claimFreeChipsAction,
      onBuyChips: handleBuyChips,
      onWithdrawChips: handleWithdrawChips,
      hasClaimedFreeChips
    }
  ), [
    walletBalanceDisplay,
    withdrawableDisplay,
    pendingAction,
    claimFreeChipsAction,
    handleBuyChips,
    handleWithdrawChips,
    hasClaimedFreeChips
  ]);

  useEffect(() => {
    if (!joinOpen) {
      setJoinAmount('');
      setJoinTableId(null);
    }
  }, [joinOpen]);

  const handleCreateTable = async () => {
    const min = parseChipAmount(minBuyIn);
    const max = parseChipAmount(maxBuyIn);
    if (min === null || max === null) return;
    const success = await actions.createTable(min, max);
    if (success) {
      setCreateOpen(false);
    }
  };

  const handleLeaveCurrentTable = async () => {
    const left = await actions.leaveCurrentTable();
    if (left) {
      toast.success('You left your current table. Enter a buy-in to join this table.');
    }
  };

  const handleJoinTable = async () => {
    if (joinTableId === null) return;
    if (isSwitchingTable) {
      toast.error('Leave your existing table before joining a new one.');
      return;
    }
    const amount = parseChipAmount(joinAmount);
    if (amount === null) return;
    const success = await actions.joinTable(joinTableId, amount);
    if (success) {
      setJoinOpen(false);
      setJoinAmount('');
      navigate(`/game/${joinTableId.toString()}`);
    }
  };

  return (
    <div className={cn('min-h-screen bg-slate-950 text-white', heroBackground)}>
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(10,23,36,0.65),rgba(5,12,24,0.92))]" />
      <main className="relative mx-auto flex w-full max-w-6xl flex-col gap-10 px-4 py-16 sm:px-6 lg:px-8">
        <SiteHeader playerTableId={playerTableId} tablePhase={currentTable?.phase} walletPanel={headerWalletPanel} />
        <TestnetBanner />
        <BankHealthBanner />
        <section className="grid gap-10 lg:grid-cols-[minmax(0,1.05fr),380px]">
          <div className="space-y-6">
            {/* <Badge variant="secondary" className="bg-primary/20 text-primary-foreground/90">
              Zama fhEVM · Sepolia Testnet
            </Badge> */}
            <h1 className="text-3xl font-black tracking-tight text-white sm:text-4xl lg:text-5xl">
              CipherJack: World's First FHE-Powered Blackjack
            </h1>
            <p className="max-w-2xl text-base text-white/80 sm:text-lg">
              Play blackjack on Sepolia with on-chain chips and encrypted card hands. Built on Zama
              fhEVM — only your wallet can decrypt your cards. Bets and payouts settle automatically
              on-chain.
            </p>
            <div className="flex flex-wrap gap-3">
              <Button
                size="lg"
                className="gap-2 bg-primary text-primary-foreground hover:bg-primary/90"
                onClick={() => {
                  const target = playerTableId && playerTableId > 0n ? playerTableId : tables[0]?.id ?? 1n;
                  navigate(`/game/${target.toString()}`);
                }}
                disabled={!walletConnected}
              >
                {playerTableId && playerTableId > 0n ? 'Resume Game' : 'Browse Tables'}
                <ArrowRight className="h-4 w-4" />
              </Button>
              <Button
                size="lg"
                variant="outline"
                className="border-primary/60 text-primary hover:bg-primary/10"
                onClick={() => setCreateOpen(true)}
                disabled={!walletConnected}
              >
                Create Table
              </Button>
            </div>
            {!walletConnected && (
              <p className="text-sm text-white/55">Connect your wallet on Sepolia to play.</p>
            )}
            <div className="grid gap-4 sm:grid-cols-2">
              <LobbyFeature
                icon={ShieldCheck}
                title="Encrypted On-Chain Hands"
                description="Card ranks and suits are encrypted on-chain with Zama fhEVM. Only your wallet can decrypt your hand."
              />
              <LobbyFeature
                icon={Zap}
                title="Live Table Play"
                description="Multiplayer blackjack with on-chain turns, encrypted deals, and automatic hand settlement."
              />
              <LobbyFeature
                icon={Cpu}
                title="On-Chain Settlement"
                description="Every wager and payout is enforced by the smart contract on Sepolia — transparent and automatic."
              />
            </div>
          </div>
          <Card className="border-primary/25 bg-card/70 shadow-xl backdrop-blur">
            <CardHeader className="space-y-2">
              <CardTitle className="text-xl font-semibold text-white">
                Tables Overview
              </CardTitle>
              <p className="text-sm text-white/60">
                Browse active CipherJack tables and claim your seat. Buy-ins use on-chain wallet chips
                (claim {FREE_CHIP_GRANT.toLocaleString()} free promo chips or buy with Sepolia ETH).
              </p>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="flex items-center justify-between text-xs uppercase tracking-[0.4em] text-white/60">
                <span>Tables</span>
                <span>{tables.length}</span>
              </div>
              <Separator className="bg-white/10" />
              <div className="grid gap-4 max-h-[500px] overflow-y-auto pr-1">
                {isLoading && tables.length === 0 && (
                  <>
                    <TableCardSkeleton />
                    <TableCardSkeleton />
                  </>
                )}
                {!isLoading && tables.length === 0 && (
                  <div className="rounded-2xl border border-dashed border-primary/30 bg-black/30 p-6 text-center text-sm text-white/70">
                    No tables yet. Be the first to create a table.
                  </div>
                )}
                {tables.map((table) => {
                  const statusPill =
                    table.status === 0
                      ? 'Waiting'
                      : table.status === 1
                        ? 'Active'
                        : 'Closed';
                  return (
                    <Card key={table.id.toString()} className="border-primary/20 bg-black/30 shadow-lg">
                      <CardContent className="space-y-4 p-5">
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <div>
                            <p className="text-xs uppercase tracking-[0.4em] text-white/40">Table #{table.id.toString()}</p>
                            <h3 className="text-lg font-semibold text-white">Table {table.id.toString()}</h3>
                          </div>
                          <TablePill label={statusPill} />
                        </div>
                        <div className="grid grid-cols-2 gap-3 text-sm text-white/70">
                          <div>
                            <span className="text-xs uppercase tracking-[0.35em] text-white/40">Min Buy-in</span>
                            <p className="text-base font-semibold text-white">{formatChips(table.minBuyIn)}</p>
                          </div>
                          <div>
                            <span className="text-xs uppercase tracking-[0.35em] text-white/40">Max Buy-in</span>
                            <p className="text-base font-semibold text-white">{formatChips(table.maxBuyIn)}</p>
                          </div>
                          <div>
                            <span className="text-xs uppercase tracking-[0.35em] text-white/40">Players</span>
                            <p className="text-base font-semibold text-white">
                              {table.playersSeated}/{table.playerCapacity}
                            </p>
                          </div>
                          <div>
                            <span className="text-xs uppercase tracking-[0.35em] text-white/40">Pot</span>
                            <p className="text-base font-semibold text-white">{formatChips(table.pot)}</p>
                          </div>
                        </div>
                        <div className="grid gap-2 sm:grid-cols-2">
                          <Button
                            className="w-full bg-primary text-primary-foreground hover:bg-primary/90"
                            disabled={!walletConnected || pendingAction !== null}
                            onClick={() => {
                              if (playerTableId && table.id === playerTableId) {
                                navigate(`/game/${table.id.toString()}`);
                              } else {
                                setJoinTableId(table.id);
                                setJoinOpen(true);
                              }
                            }}
                          >
                            {playerTableId && table.id === playerTableId ? 'Resume' : 'Join Table'}
                          </Button>
                          <Button
                            variant="outline"
                            className="w-full border-primary/50 text-primary hover:bg-primary/10"
                            onClick={() => navigate(`/game/${table.id.toString()}`)}
                          >
                            Spectate
                          </Button>
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        </section>

        <section className="space-y-6">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h2 className="text-2xl font-semibold text-white">Why CipherJack?</h2>
              <p className="text-sm text-white/70">
                A polished blackjack experience with encrypted private hands, cinematic UI, and
                automatic on-chain chip settlement.
              </p>
            </div>
            <Button
              variant="outline"
              className="border-primary/60 text-primary hover:bg-primary/10"
              onClick={() => setCreateOpen(true)}
              disabled={!walletConnected}
            >
              Create Table
            </Button>
          </div>
          <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
            <Card className="border-primary/20 bg-black/40">
              <CardHeader>
                <CardTitle className="text-lg text-white">Private Hands</CardTitle>
              </CardHeader>
              <CardContent className="text-sm text-white/70">
                Your card faces stay encrypted on-chain. Other players cannot see your hand values —
                only your wallet can decrypt your cards for you.
              </CardContent>
            </Card>
            <Card className="border-primary/20 bg-black/40">
              <CardHeader>
                <CardTitle className="text-lg text-white">Wallet Chips</CardTitle>
              </CardHeader>
              <CardContent className="text-sm text-white/70">
                Claim {FREE_CHIP_GRANT.toLocaleString()} free promo chips once, or buy more with Sepolia
                test ETH. Chips live in your wallet on-chain; only ETH-purchased chips can be withdrawn.
              </CardContent>
            </Card>
            <Card className="border-primary/20 bg-black/40">
              <CardHeader>
                <CardTitle className="text-lg text-white">Live Spectator Mode</CardTitle>
              </CardHeader>
              <CardContent className="text-sm text-white/70">
                Follow tables in real time. Pots, wagers, and results are public; player card faces stay
                encrypted until revealed.
              </CardContent>
            </Card>
            <Card className="border-primary/20 bg-black/40 md:col-span-2 xl:col-span-1">
              <CardHeader>
                <CardTitle className="text-lg text-white">Powered by Zama fhEVM</CardTitle>
              </CardHeader>
              <CardContent className="text-sm text-white/70">
                CipherJack stores encrypted card handles on Sepolia using Zama&apos;s fully homomorphic
                encryption. Game logic and payouts remain on-chain while card privacy is preserved
                during play.
              </CardContent>
            </Card>
          </div>
        </section>
      </main>
      <SiteFooter />

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="border-primary/40 bg-slate-950/95 text-white">
          <DialogHeader>
            <DialogTitle>Create a New Table</DialogTitle>
            <DialogDescription className="text-white/60">
              Set stake limits for your blackjack table.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <label className="text-xs uppercase tracking-[0.35em] text-white/60">Min Buy-in (chips)</label>
              <Input
                value={minBuyIn}
                onChange={(event) => setMinBuyIn(event.target.value)}
                type="number"
                min={1}
                className="bg-white/10 text-white"
              />
            </div>
            <div className="space-y-2">
              <label className="text-xs uppercase tracking-[0.35em] text-white/60">Max Buy-in (chips)</label>
              <Input
                value={maxBuyIn}
                onChange={(event) => setMaxBuyIn(event.target.value)}
                type="number"
                min={1}
                className="bg-white/10 text-white"
              />
            </div>
          </div>
          <DialogFooter>
          <Button
            className="w-full bg-primary text-primary-foreground hover:bg-primary/90"
            onClick={handleCreateTable}
            disabled={!walletConnected || pendingAction !== null}
          >
            {pendingAction === 'createTable' ? 'Creating…' : 'Create Table'}
          </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={joinOpen} onOpenChange={setJoinOpen}>
        <DialogContent className="border-primary/40 bg-slate-950/95 text-white">
          <DialogHeader>
            <DialogTitle>Join Table {selectedTable?.id.toString()}</DialogTitle>
            <DialogDescription className="text-white/60">
              Enter the chip amount you wish to bring to the table.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            {isSwitchingTable && playerTableId ? (
              <div className="space-y-4 text-sm text-white/80">
                <p>
                  You are currently seated at Table #{playerTableId.toString()}. Leave that table before joining this one.
                </p>
                <Button
                  variant="outline"
                  className="w-full border-primary/60 text-primary hover:bg-primary/10"
                  onClick={handleLeaveCurrentTable}
                  disabled={!walletConnected || pendingAction !== null}
                >
                  Leave Current Table
                </Button>
              </div>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-3 text-sm text-white/70">
                  <div>
                    <span className="text-xs uppercase tracking-[0.35em] text-white/40">Min</span>
                    <p className="text-base font-semibold text-white">{selectedTable ? formatChips(selectedTable.minBuyIn) : '—'}</p>
                  </div>
                  <div>
                    <span className="text-xs uppercase tracking-[0.35em] text-white/40">Max</span>
                    <p className="text-base font-semibold text-white">{selectedTable ? formatChips(selectedTable.maxBuyIn) : '—'}</p>
                  </div>
                  <div>
                    <span className="text-xs uppercase tracking-[0.35em] text-white/40">Players</span>
                    <p className="text-base font-semibold text-white">
                      {selectedTable?.playersSeated ?? 0}/{selectedTable?.playerCapacity ?? MAX_PLAYERS}
                    </p>
                  </div>
                  <div>
                    <span className="text-xs uppercase tracking-[0.35em] text-white/40">Pot</span>
                    <p className="text-base font-semibold text-white">{selectedTable ? formatChips(selectedTable.pot) : 0}</p>
                  </div>
                </div>
                <div className="space-y-2">
                  <label className="text-xs uppercase tracking-[0.35em] text-white/60">Buy-in (chips)</label>
                  <Input
                    value={joinAmount}
                    onChange={(event) => setJoinAmount(event.target.value)}
                    placeholder="Enter chip amount"
                    type="number"
                    min={Number(selectedTable?.minBuyIn ?? 1)}
                    className="bg-white/10 text-white"
                  />
                  {walletChips !== undefined && walletChips === 0n && (
                    <p className="text-xs text-amber-300/90">
                      Your wallet has 0 chips. Claim {FREE_CHIP_GRANT.toLocaleString()} free promo chips
                      from the wallet panel, or buy chips with Sepolia test ETH.
                    </p>
                  )}
                </div>
              </>
            )}
          </div>
          <DialogFooter>
            <Button
              className="w-full bg-primary text-primary-foreground hover:bg-primary/90"
              onClick={handleJoinTable}
              disabled={!walletConnected || pendingAction !== null || isSwitchingTable || joinTableId === null}
            >
              Join Table
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default Index;
