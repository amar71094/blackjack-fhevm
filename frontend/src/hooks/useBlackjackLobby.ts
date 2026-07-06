import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAccount, usePublicClient, useReadContract, useWalletClient } from 'wagmi';
import { sepolia } from 'wagmi/chains';
import { toast } from '@/lib/toast';
import { blackjackContract } from '@/lib/contracts';
import { TableStatus, GamePhase } from '@/types/blackjackContract';
import { devError, devLog } from '@/lib/devLog';
import { friendlyRevertMessage, writeBlackjackContract } from '@/lib/contractWrite';
import { validateBuyChipsPreflight, validateWithdrawChipsPreflight } from '@/lib/economyHelpers';
import {
  describeUserFacingError,
  getActionErrorTitle,
  logTechnicalError,
  shortenTxHash
} from '@/lib/userMessages';
import { waitForTxReceipt } from '@/lib/txReceipt';

export interface LobbyTable {
  id: bigint;
  status: TableStatus;
  minBuyIn: number;
  maxBuyIn: number;
  pot: number;
  phase: string;
  playersSeated: number;
  playerCapacity: number;
}

export interface BlackjackLobbyData {
  tables: LobbyTable[];
  isLoading: boolean;
  pendingAction: string | null;
  refetchTables: () => Promise<void>;
  playerTableId?: bigint;
  walletChips?: bigint;
  withdrawableChips?: bigint;
  hasClaimedFreeChips?: boolean;
  actions: {
    createTable: (minBuyIn: bigint, maxBuyIn: bigint) => Promise<boolean>;
    joinTable: (tableId: bigint, buyIn: bigint) => Promise<boolean>;
    leaveCurrentTable: () => Promise<boolean>;
    claimFreeChips: () => Promise<boolean>;
    buyChips: (weiAmount: bigint) => Promise<boolean>;
    withdrawChips: (chipAmount: bigint) => Promise<boolean>;
  };
}

const MAX_PLAYERS = 4;
const LOBBY_POLL_INTERVAL = 45_000;

const phaseLabels: Record<GamePhase, string> = {
  [GamePhase.WaitingForPlayers]: 'betting',
  [GamePhase.Dealing]: 'dealing',
  [GamePhase.PlayerTurns]: 'player-turn',
  [GamePhase.DealerTurn]: 'dealer-turn',
  [GamePhase.Showdown]: 'showdown',
  [GamePhase.Completed]: 'waiting'
};

const toNumber = (value: unknown) => Number(value ?? 0);
const toBigInt = (value: unknown) => (typeof value === 'bigint' ? value : BigInt(value ?? 0));

// Orchestrates lobby reads (table list + player's seat) and exposes lightweight actions.
export const useBlackjackLobby = (): BlackjackLobbyData => {
  const { address, chainId } = useAccount();
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [isWriting, setIsWriting] = useState(false);

  const {
    data: rawSummaries,
    refetch,
    isFetching,
    isSuccess: summariesSuccess,
    isError: summariesError,
    error: summariesQueryError
  } = useReadContract({
    ...blackjackContract,
    functionName: 'getAllTableSummaries',
    query: {
      enabled: Boolean(blackjackContract.address),
      refetchInterval: LOBBY_POLL_INTERVAL
    }
  });

  useEffect(() => {
    if (summariesSuccess && rawSummaries) {
      devLog('[BlackjackLobby] getAllTableSummaries success', rawSummaries);
    }
  }, [summariesSuccess, rawSummaries]);

  useEffect(() => {
    if (summariesError && summariesQueryError) {
      devError('[BlackjackLobby] getAllTableSummaries error', summariesQueryError);
    }
  }, [summariesError, summariesQueryError]);

  const tables = useMemo(() => {
    if (!rawSummaries) return [];
    return (rawSummaries as unknown[]).map((entry) => {
      const record = entry as Record<string, unknown>;
      const phase = toNumber(record.phase) as GamePhase;
      return {
        id: toBigInt(record.id),
        status: toNumber(record.status) as TableStatus,
        minBuyIn: toNumber(record.minBuyIn),
        maxBuyIn: toNumber(record.maxBuyIn),
        pot: toNumber(record.pot),
        phase: phaseLabels[phase] ?? 'waiting',
        playersSeated: toNumber(record.playersSeated),
        playerCapacity: MAX_PLAYERS
      } satisfies LobbyTable;
    });
  }, [rawSummaries]);

  const {
    data: playerTableId,
    refetch: refetchPlayerTable
  } = useReadContract({
    ...blackjackContract,
    functionName: 'playerTableId',
    args: address ? [address] as const : undefined,
    query: {
      enabled: Boolean(address && blackjackContract.address),
      refetchInterval: LOBBY_POLL_INTERVAL
    }
  });

  const {
    data: walletChips,
    refetch: refetchWalletChips
  } = useReadContract({
    ...blackjackContract,
    functionName: 'playerChips',
    args: address ? [address] as const : undefined,
    query: {
      enabled: Boolean(address && blackjackContract.address),
      refetchInterval: LOBBY_POLL_INTERVAL
    }
  });

  const {
    data: hasClaimedFreeChips,
    refetch: refetchClaimStatus
  } = useReadContract({
    ...blackjackContract,
    functionName: 'hasClaimedFreeChips',
    args: address ? [address] as const : undefined,
    query: {
      enabled: Boolean(address && blackjackContract.address),
      refetchInterval: LOBBY_POLL_INTERVAL
    }
  });

  const {
    data: withdrawableChips,
    refetch: refetchWithdrawableChips
  } = useReadContract({
    ...blackjackContract,
    functionName: 'withdrawableChips',
    args: address ? [address] as const : undefined,
    query: {
      enabled: Boolean(address && blackjackContract.address),
      refetchInterval: LOBBY_POLL_INTERVAL
    }
  });

  const waitForReceipt = useCallback(
    async (hash: `0x${string}`) => {
      if (!publicClient) return;
      await waitForTxReceipt(publicClient, hash);
    },
    [publicClient]
  );

  const requireWallet = useCallback(() => {
    if (!address) {
      toast.error('Connect your wallet to continue.');
      return false;
    }
    if (!blackjackContract.address) {
      logTechnicalError(
        '[BlackjackLobby] Blackjack contract is not configured',
        new Error('VITE_BLACKJACK_CONTRACT is not set')
      );
      toast.error('CipherJack is temporarily unavailable. Please try again later.');
      return false;
    }
    if (chainId !== sepolia.id) {
      toast.error('Switch your wallet to the Sepolia test network to play.');
      return false;
    }
    return true;
  }, [address, chainId]);

  type LobbyFunction =
    | 'createTable'
    | 'joinTable'
    | 'leaveTable'
    | 'claimFreeChips'
    | 'buyChips'
    | 'withdrawChips';

  const refreshAfterWrite = useCallback(async () => {
    const tasks: Promise<unknown>[] = [refetch()];
    if (refetchPlayerTable) tasks.push(refetchPlayerTable());
    if (refetchWalletChips) tasks.push(refetchWalletChips());
    if (refetchWithdrawableChips) tasks.push(refetchWithdrawableChips());
    if (refetchClaimStatus) tasks.push(refetchClaimStatus());
    await Promise.allSettled(tasks);
  }, [
    refetch,
    refetchClaimStatus,
    refetchPlayerTable,
    refetchWalletChips,
    refetchWithdrawableChips
  ]);

  const execute = useCallback(
    async (
      functionName: LobbyFunction,
      args: readonly unknown[] = [],
      value?: bigint,
      successMessage?: string
    ): Promise<boolean> => {
      if (!requireWallet()) return false;
      if (!publicClient || !walletClient) {
        toast.error('Your wallet is not ready. Reconnect and try again.');
        return false;
      }
      try {
        setPendingAction(functionName);
        setIsWriting(true);
        devLog('[BlackjackLobby] writeContract start', { functionName, args, value });
        const hash = await writeBlackjackContract({
          publicClient,
          walletClient,
          contractAddress: blackjackContract.address!,
          functionName,
          args: args as never,
          value
        });
        toast.message('Transaction submitted', { description: shortenTxHash(hash) });
        devLog('[BlackjackLobby] writeContract submitted', { functionName, hash });
        await waitForReceipt(hash);
        devLog('[BlackjackLobby] writeContract confirmed', { functionName, hash });
        if (successMessage) {
          toast.success(successMessage);
        }
        await refreshAfterWrite();
        return true;
      } catch (error) {
        logTechnicalError(`[BlackjackLobby] writeContract error (${functionName})`, error, {
          functionName,
          args,
          value
        });
        const title = getActionErrorTitle(functionName);
        const description = friendlyRevertMessage(error) ?? describeUserFacingError(error);
        toast.error(title, { description });
        return false;
      } finally {
        setPendingAction(null);
        setIsWriting(false);
      }
    },
    [publicClient, refreshAfterWrite, requireWallet, waitForReceipt, walletClient]
  );

  const actions = useMemo(
    () => ({
      createTable: async (minBuyIn: bigint, maxBuyIn: bigint) => {
        if (minBuyIn <= 0n || maxBuyIn <= 0n) {
          toast.error('Stake values must be positive.');
          return false;
        }
        if (maxBuyIn < minBuyIn) {
          toast.error('Max buy-in must not be lower than min buy-in.');
          return false;
        }
        return execute('createTable', [minBuyIn, maxBuyIn] as const, undefined, 'Table created');
      },
      joinTable: async (tableId: bigint, buyIn: bigint) => {
        if (tableId <= 0n) {
          toast.error('Select a valid table.');
          return false;
        }
        if (buyIn <= 0n) {
          toast.error('Buy-in must be greater than zero.');
          return false;
        }
        const targetTable = tables.find((table) => table.id === tableId);
        if (targetTable) {
          if (buyIn < BigInt(targetTable.minBuyIn) || buyIn > BigInt(targetTable.maxBuyIn)) {
            toast.error(`Buy-in must be between ${targetTable.minBuyIn} and ${targetTable.maxBuyIn} chips.`);
            return false;
          }
          if (targetTable.playersSeated >= targetTable.playerCapacity) {
            toast.error('This table is full.');
            return false;
          }
        }
        const walletBalance = walletChips as bigint | undefined;
        if (walletBalance === undefined) {
          toast.error('Wallet chip balance is still loading — try again in a moment.');
          return false;
        }
        if (walletBalance < buyIn) {
          toast.error('Not enough chips in your wallet. Claim free chips or buy more first.');
          return false;
        }
        if (playerTableId && playerTableId !== 0n) {
          toast.error('Leave your current table before joining another.');
          return false;
        }
        return execute('joinTable', [tableId, buyIn] as const, undefined, 'Joined table');
      },
      leaveCurrentTable: async () => {
        if (!playerTableId || playerTableId === 0n) {
          toast.error('You are not seated at any table.');
          return false;
        }
        return execute('leaveTable', [playerTableId] as const, undefined, 'Left current table');
      },
      claimFreeChips: async () => {
        if (hasClaimedFreeChips) {
          toast.info('You have already claimed your free chips.');
          return false;
        }
        return execute('claimFreeChips', [], undefined, 'Free chips claimed');
      },
      buyChips: async (weiAmount: bigint) => {
        if (weiAmount <= 0n) {
          toast.error('Send a positive ETH amount.');
          return false;
        }
        if (!publicClient || !address || !blackjackContract.address) {
          toast.error('Your wallet is not ready. Reconnect and try again.');
          return false;
        }
        try {
          const preflightError = await validateBuyChipsPreflight(
            publicClient,
            blackjackContract.address,
            address,
            weiAmount,
            playerTableId as bigint | undefined
          );
          if (preflightError) {
            toast.error(preflightError);
            return false;
          }
        } catch (error) {
          logTechnicalError('[BlackjackLobby] buyChips preflight failed', error);
        }
        return execute('buyChips', [] as const, weiAmount, 'Chips purchased');
      },
      withdrawChips: async (chipAmount: bigint) => {
        if (chipAmount <= 0n) {
          toast.error('Enter a withdraw amount greater than zero.');
          return false;
        }
        if (!publicClient || !address || !blackjackContract.address) {
          toast.error('Your wallet is not ready. Reconnect and try again.');
          return false;
        }
        try {
          const preflightError = await validateWithdrawChipsPreflight(
            publicClient,
            blackjackContract.address,
            address,
            chipAmount,
            playerTableId as bigint | undefined,
            walletChips as bigint | undefined
          );
          if (preflightError) {
            toast.error(preflightError);
            return false;
          }
        } catch (error) {
          logTechnicalError('[BlackjackLobby] withdrawChips preflight failed', error);
        }
        return execute(
          'withdrawChips',
          [chipAmount] as const,
          undefined,
          `Withdrew ${chipAmount.toString()} chips`
        );
      }
    }),
    [address, execute, hasClaimedFreeChips, playerTableId, publicClient, tables, walletChips]
  );

  return {
    tables,
    isLoading: isFetching || isWriting,
    pendingAction,
    refetchTables: refetch,
    playerTableId: playerTableId as bigint | undefined,
    walletChips: walletChips as bigint | undefined,
    withdrawableChips: withdrawableChips as bigint | undefined,
    hasClaimedFreeChips: typeof hasClaimedFreeChips === 'boolean' ? hasClaimedFreeChips : undefined,
    actions
  };
};