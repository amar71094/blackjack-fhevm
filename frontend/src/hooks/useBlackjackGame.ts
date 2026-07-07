import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from '@/lib/toast';
import {
  useAccount,
  usePublicClient,
  useReadContract,
  useWatchContractEvent,
  useWalletClient
} from 'wagmi';
import { sepolia } from 'wagmi/chains';
import { blackjackContract } from '@/lib/contracts';
import { blackjackAbi } from '@/lib/blackjackAbi';
import { GameState, Player, Card } from '@/types/blackjack';
import { ContractTable, GamePhase, PendingKind, WinnerEventPayload } from '@/types/blackjackContract';
import {
  mergeTableWithHandResult,
  normalizeHandResult,
  normalizePlayTable,
  toUiGameState,
  toShowdownSummaryFromHand,
  summarizeShowdown,
  ShowdownSummary,
  toHiddenCard,
  toUiCard,
  calculateHandValue,
  hasRevealedCards,
  resolvePlayerBust
} from '@/utils/contractMapping';
import { ensureFhevmInstance, getBrowserProvider, hexlifyHandle, readClearValue } from '@/lib/fhevm';
import {
  loadOrCreateSignature,
  invalidateStoredSignature,
  type StoredDecryptionSignature
} from '@/lib/decryptionSignature';
import { devDebug, devError, devLog, devWarn } from '@/lib/devLog';
import { friendlyRevertMessage, writeBlackjackContract } from '@/lib/contractWrite';
import { validateBuyChipsPreflight, validateWithdrawChipsPreflight } from '@/lib/economyHelpers';
import {
  describeUserFacingError,
  extractErrorMessage,
  getActionErrorTitle,
  logTechnicalError,
  shortenTxHash
} from '@/lib/userMessages';
import { waitForTxReceipt } from '@/lib/txReceipt';
import { fetchTableActivity, getTableActivityBaseUrl } from '@/lib/tableActivityApi';
import { mergeLatestHandActivity, type TableActivityHand } from '@/lib/tableActivityStore';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

const DEFAULT_TABLE_ID = 1n;
const TABLE_POLL_IDLE_INTERVAL = 45_000;
const TABLE_POLL_ACTIVE_INTERVAL = 2_000;
const TURN_POLL_IDLE_INTERVAL = 45_000;
const TURN_POLL_ACTIVE_INTERVAL = 2_000;
const PLAYER_POLL_INTERVAL = 45_000;
const WALLET_POLL_INTERVAL = 60_000;
const CLAIM_POLL_INTERVAL = 120_000;
const AGGRESSIVE_POLL_DURATION_MS = 90_000;

type OptimisticOverlay = {
  bet?: bigint;
  pendingKind?: PendingKind;
  pendingPlayer?: string;
  hasActed?: boolean;
};

const toLower = (value?: string | null) => value?.toLowerCase();

const HANDLE_RETRY_LIMIT = 3;
const HANDLE_RETRY_DELAY_MS = 250;
const PLAYER_DECRYPT_RETRY_DELAY_MS = 20_000;
const DEALER_DECRYPT_RETRY_DELAY_MS = 25_000;

const messageFromError = (error: unknown): string => (
  (error as { shortMessage?: string })?.shortMessage ??
  (error as Error)?.message ??
  (typeof error === 'string' ? error : '')
);

const isRateLimitError = (error: unknown): boolean => {
  const message = messageFromError(error);
  return typeof message === 'string' && /rate[\s-]?limit|too many requests|429/i.test(message);
};

const isAuthError = (error: unknown): boolean => {
  const message = messageFromError(error);
  return typeof message === 'string' && /unauthorized|authenticat|api key|forbidden|401/i.test(message);
};

const isNetworkLikeError = (error: unknown): boolean => {
  const message = messageFromError(error).toLowerCase();
  if (!message) return false;
  return /fetch|network|timeout|offline|relayer|gateway|disconnect/i.test(message);
};

const shouldResetDecryptSignature = (error: unknown): boolean => {
  const message = messageFromError(error).toLowerCase();
  if (!message) return false;
  return (
    message.includes('user decrypt failed') ||
    message.includes('invalid signature') ||
    message.includes('kms') ||
    message.includes('500')
  );
};

const sleep = (ms: number) => new Promise<void>((resolve) => {
  const id = setTimeout(() => {
    clearTimeout(id);
    resolve();
  }, ms);
});

type DecryptState = 'idle' | 'pending' | 'success' | 'error';

export interface UseBlackjackGameOptions {
  tableId?: bigint;
}

export interface BlackjackGameData {
  contractAddress?: `0x${string}`;
  tableId: bigint;
  hasTable: boolean;
  table?: ContractTable;
  gameState?: GameState;
  connectedPlayer?: Player;
  walletChips?: bigint;
  withdrawableChips?: bigint;
  hasClaimedFreeChips?: boolean;
  playerTableId?: bigint;
  isSeated: boolean;
  isPlayerTurn?: boolean;
  oraclePending: boolean;
  oraclePendingForSelf: boolean;
  pendingOracleKind: PendingKind;
  pendingOraclePlayer: string | null;
  oracleConfirmingBust: boolean;
  tableActivity: TableActivityHand[];
  refreshTableActivity: () => Promise<void>;
  tableStuck: boolean;
  turnTimer: { secondsRemaining: number; turnTimeoutSeconds: number } | null;
  winners: WinnerEventPayload | null;
  isLoading: boolean;
  showdownResult: ShowdownSummary | null;
  awaitingNextHand: boolean;
  playerDecryptState: DecryptState;
  dealerDecryptState: DecryptState;
  dealerRevealTimestamp: number;
  dealerPublicHand?: { cards: Card[]; total: number } | null;
  dealerHandForLastResult?: { cards: Card[]; total: number } | null;
  connectedDecryptedHand?: { cards: Card[]; total: number };
  lastHandSummary: ShowdownSummary | null;
  refetchAll: () => Promise<void>;
  actions: {
    claimFreeChips: () => Promise<boolean>;
    buyChips: (weiAmount: bigint) => Promise<boolean>;
    withdrawChips: (chipAmount: bigint) => Promise<boolean>;
    createTable: (minBuyIn: bigint, maxBuyIn: bigint) => Promise<boolean>;
    joinTable: (buyIn: bigint) => Promise<boolean>;
    leaveTable: () => Promise<boolean>;
    cashOut: () => Promise<boolean>;
    topUpChips: (amount: bigint) => Promise<boolean>;
    placeBet: (amount: bigint) => Promise<boolean>;
    hit: () => Promise<boolean>;
    stand: () => Promise<boolean>;
    doubleDown: () => Promise<boolean>;
    acknowledgeShowdown: () => Promise<void>;
    retryPlayerDecrypt: () => void;
    retryDealerDecrypt: () => void;
    resetDecryption: () => void;
  };
  pendingAction: string | null;
}

// Rich game hook – handles reads, write helpers, and showdown lifecycle.
export const useBlackjackGame = (
  { tableId = DEFAULT_TABLE_ID }: UseBlackjackGameOptions = {}
): BlackjackGameData => {
  const { address: walletAddress, chainId } = useAccount();
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [isWriting, setIsWriting] = useState(false);
  const [optimisticOverlay, setOptimisticOverlay] = useState<OptimisticOverlay | null>(null);
  const [aggressivePollUntil, setAggressivePollUntil] = useState(0);
  const [pollMode, setPollMode] = useState<'idle' | 'active'>('idle');
  const [winners, setWinners] = useState<WinnerEventPayload | null>(null);
  const [tableActivity, setTableActivity] = useState<TableActivityHand[]>([]);

  const [acknowledgedResultTimestamp, setAcknowledgedResultTimestamp] = useState<number>(0);
  type CachedDecryptedHand = { cards: Card[]; total: number; signature: string };

  const [decryptedHands, setDecryptedHands] = useState<Record<string, CachedDecryptedHand>>({});
  const [dealerPublicHand, setDealerPublicHand] = useState<{ cards: Card[]; total: number } | null>(null);
  const [playerDecryptState, setPlayerDecryptState] = useState<DecryptState>('idle');
  const [dealerDecryptState, setDealerDecryptState] = useState<DecryptState>('idle');
  const [dealerRevealTimestamp, setDealerRevealTimestamp] = useState(0);
  const playerDecryptErrorRef = useRef<string | null>(null);
  const dealerDecryptErrorRef = useRef<number | null>(null);
  const lastPlayerHandleSignatureRef = useRef<string | null>(null);
  const lastDealerHandleSignatureRef = useRef<string | null>(null);
  const lastPlayerDecryptErrorAtRef = useRef<number>(0);
  const lastDealerDecryptErrorAtRef = useRef<number>(0);
  const lastPlayerHandSignatureRef = useRef<string>('0');
  const lastPlayerAttemptedSignatureRef = useRef<string>('0');
  const failedPlayerHandSignatureRef = useRef<string | null>(null);
  const playerDecryptInFlightRef = useRef<string | null>(null);
  const dealerDecryptInFlightRef = useRef<number | null>(null);
  const lastDealerResultTimestampRef = useRef<number>(0);
  const refetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const playerDecryptCacheRef = useRef(new Map<string, { cards: Card[]; total: number }>());
  const dealerDecryptCacheRef = useRef(new Map<string, { cards: Card[]; total: number }>());
  const playerDecryptRetryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dealerDecryptRetryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const playerHandleCacheRef = useRef(new Map<string, { rank: `0x${string}`[]; suit: `0x${string}`[]; signature: string }>());
  const dealerHandleCacheRef = useRef(new Map<number, { rank: `0x${string}`[]; suit: `0x${string}`[]; signature: string }>());
  const playerDecryptBlockedRef = useRef(false);
  const dealerDecryptBlockedRef = useRef(false);
  const [connectedDecryptedHandState, setConnectedDecryptedHandState] = useState<CachedDecryptedHand | undefined>(undefined);
  const [handSnapshotCache, setHandSnapshotCache] = useState<Record<string, CachedDecryptedHand>>({});
  const [dealerHandByTimestamp, setDealerHandByTimestamp] = useState<
    Record<number, { cards: Card[]; total: number }>
  >({});
  const liveHandSnapshotsRef = useRef<Record<string, CachedDecryptedHand>>({});
  const lastSnapshottedResultRef = useRef(0);

  const lowerWalletAddress = useMemo(() => toLower(walletAddress), [walletAddress]);

  useEffect(() => {
    playerDecryptBlockedRef.current = false;
    dealerDecryptBlockedRef.current = false;
  }, [walletAddress]);

  const contractAddress = blackjackContract.address;
  const transportType = publicClient?.transport?.type;
  const supportsFilters = transportType === 'webSocket' || transportType === 'ipc';
  const shouldPoll = !supportsFilters;
  const eventsEnabled = Boolean(contractAddress) && supportsFilters;
  const readEnabled = Boolean(contractAddress);
  const tablePollInterval = shouldPoll
    ? pollMode === 'active'
      ? TABLE_POLL_ACTIVE_INTERVAL
      : TABLE_POLL_IDLE_INTERVAL
    : false;
  const turnPollInterval = shouldPoll
    ? pollMode === 'active'
      ? TURN_POLL_ACTIVE_INTERVAL
      : TURN_POLL_IDLE_INTERVAL
    : false;

  const {
    data: tablesCount,
    refetch: refetchTablesCount
  } = useReadContract({
    ...blackjackContract,
    functionName: 'getTablesCount',
    query: {
      enabled: readEnabled,
      refetchInterval: tablePollInterval
    }
  });

  const hasTable = Boolean(tablesCount && tableId <= (tablesCount as bigint));

  const {
    data: rawTable,
    refetch: refetchTable,
    isFetching: isFetchingTable
  } = useReadContract({
    ...blackjackContract,
    functionName: 'getTablePlayState',
    args: [tableId] as const,
    query: {
      enabled: readEnabled && hasTable,
      refetchInterval: tablePollInterval,
      retry: 1
    }
  });

  const {
    data: rawHandResult,
    refetch: refetchHandResult
  } = useReadContract({
    ...blackjackContract,
    functionName: 'getLastHandResult',
    args: [tableId] as const,
    query: {
      enabled: readEnabled && hasTable,
      refetchInterval: tablePollInterval,
      retry: 1
    }
  });

  const {
    data: walletChips,
    refetch: refetchWalletChips
  } = useReadContract({
    ...blackjackContract,
    functionName: 'playerChips',
    args: walletAddress ? [walletAddress] as const : undefined,
    query: {
      enabled: readEnabled && Boolean(walletAddress),
      refetchInterval: shouldPoll ? WALLET_POLL_INTERVAL : false
    }
  });

  const {
    data: withdrawableChips,
    refetch: refetchWithdrawableChips
  } = useReadContract({
    ...blackjackContract,
    functionName: 'withdrawableChips',
    args: walletAddress ? [walletAddress] as const : undefined,
    query: {
      enabled: readEnabled && Boolean(walletAddress),
      refetchInterval: shouldPoll ? WALLET_POLL_INTERVAL : false
    }
  });

  const {
    data: hasClaimed,
    refetch: refetchClaimStatus
  } = useReadContract({
    ...blackjackContract,
    functionName: 'hasClaimedFreeChips',
    args: walletAddress ? [walletAddress] as const : undefined,
    query: {
      enabled: readEnabled && Boolean(walletAddress),
      refetchInterval: shouldPoll ? CLAIM_POLL_INTERVAL : false
    }
  });

  const {
    data: currentTableId,
    refetch: refetchPlayerTable
  } = useReadContract({
    ...blackjackContract,
    functionName: 'playerTableId',
    args: walletAddress ? [walletAddress] as const : undefined,
    query: {
      enabled: readEnabled && Boolean(walletAddress),
      refetchInterval: shouldPoll ? PLAYER_POLL_INTERVAL : false
    }
  });

  const {
    data: playerTurn,
    refetch: refetchTurnStatus
  } = useReadContract({
    ...blackjackContract,
    functionName: 'isPlayerTurn',
    args: walletAddress ? [tableId, walletAddress] as const : undefined,
    query: {
      enabled: readEnabled && Boolean(walletAddress) && hasTable,
      refetchInterval: turnPollInterval
    }
  });

  const { data: turnTimeoutRaw } = useReadContract({
    ...blackjackContract,
    functionName: 'TURN_TIMEOUT',
    query: {
      enabled: readEnabled && hasTable
    }
  });

  const [turnTimerTick, setTurnTimerTick] = useState(() => Date.now());

  useEffect(() => {
    if (aggressivePollUntil <= Date.now()) return;
    const delay = aggressivePollUntil - Date.now();
    const timer = window.setTimeout(() => setAggressivePollUntil(0), delay);
    return () => window.clearTimeout(timer);
  }, [aggressivePollUntil]);

  useEffect(() => {
    let chainPending = false;
    if (rawTable) {
      const playTable = normalizePlayTable(rawTable);
      chainPending = Number(playTable.pendingKind) !== PendingKind.None;
    }
    const active =
      pendingAction !== null ||
      isWriting ||
      optimisticOverlay !== null ||
      aggressivePollUntil > Date.now() ||
      chainPending;
    setPollMode(active ? 'active' : 'idle');
  }, [
    rawTable,
    pendingAction,
    isWriting,
    optimisticOverlay,
    aggressivePollUntil
  ]);

  const table = useMemo(() => {
    if (!rawTable) return undefined;
    const playTable = normalizePlayTable(rawTable);
    if (!rawHandResult) return playTable;
    const [dealerTotal, dealerBusted, results, pot, timestamp] = rawHandResult as readonly [
      bigint,
      boolean,
      unknown[],
      bigint,
      bigint
    ];
    return mergeTableWithHandResult(playTable, normalizeHandResult({
      dealerTotal,
      dealerBusted,
      results,
      pot,
      timestamp
    }));
  }, [rawTable, rawHandResult]);

  const baseGameState = useMemo(() => {
    if (!table) return undefined;
    return toUiGameState(table);
  }, [table]);

  useEffect(() => {
    if (table?.phase !== GamePhase.PlayerTurns) return;
    const id = window.setInterval(() => setTurnTimerTick(Date.now()), 1_000);
    return () => window.clearInterval(id);
  }, [table?.phase]);

const playerHandSignature = useMemo(() => {
  if (!baseGameState || !walletAddress || !table) return '0';
  const lower = toLower(walletAddress);
  const player = baseGameState.players.find((entry) => toLower(entry.address) === lower);
  if (!player || player.hand.length === 0) return '0';
  // On-chain state only exposes cardCount — do not key off hidden placeholder card ids.
  return `${table.deckIndex}:${player.hand.length}`;
}, [baseGameState, walletAddress, table]);

  const playerDecryptedHand = useMemo(() => {
    if (!walletAddress) return undefined;
    const key = lowerWalletAddress;
    if (!key) return undefined;
    const entry = decryptedHands[key];
    if (!entry) return undefined;
    return entry.signature === playerHandSignature ? entry : undefined;
  }, [walletAddress, decryptedHands, lowerWalletAddress, playerHandSignature]);

  useEffect(() => {
  if (playerHandSignature === '0') {
    playerHandleCacheRef.current.clear();
    playerDecryptBlockedRef.current = false;
  }
}, [playerHandSignature]);

  useEffect(() => {
    if (!lowerWalletAddress || playerHandSignature === '0') return;

    const player = baseGameState?.players.find(
      (entry) => toLower(entry.address) === lowerWalletAddress
    );
    const expectedCardCount = player?.hand.length ?? 0;
    if (expectedCardCount === 0) return;

    setDecryptedHands((prev) => {
      const existing = prev[lowerWalletAddress];
      if (!existing) return prev;

      if (existing.signature === playerHandSignature) {
        return prev;
      }

      // New deal or hit: drop stale cache when the on-chain hand changed shape.
      if (expectedCardCount !== existing.cards.length) {
        const next = { ...prev };
        delete next[lowerWalletAddress];
        return next;
      }

      const nextCards = existing.cards.map((card) => ({ ...card }));
      return {
        ...prev,
        [lowerWalletAddress]: {
          cards: nextCards,
          total: calculateHandValue(nextCards),
          signature: playerHandSignature
        }
      };
    });

    setConnectedDecryptedHandState((prev) => {
      if (!prev) return prev;
      if (prev.signature === playerHandSignature) return prev;
      if (expectedCardCount !== prev.cards.length) return undefined;
      const nextCards = prev.cards.map((card) => ({ ...card }));
      return {
        cards: nextCards,
        total: calculateHandValue(nextCards),
        signature: playerHandSignature
      };
    });
  }, [baseGameState, lowerWalletAddress, playerHandSignature]);

  const latestResultTimestamp = useMemo(() => {
    if (!table) return 0;
    const timestamp = Number(table.lastHandResult.timestamp ?? 0n);
    return Number.isFinite(timestamp) ? timestamp : 0;
  }, [table]);

  useEffect(() => {
    if (latestResultTimestamp === 0) {
      setDealerRevealTimestamp(0);
      return;
    }
    setDealerRevealTimestamp((prev) => (
      prev !== 0 && prev !== latestResultTimestamp ? 0 : prev
    ));
  }, [latestResultTimestamp]);

  useEffect(() => {
    if (latestResultTimestamp === 0) {
      dealerHandleCacheRef.current.clear();
      dealerDecryptBlockedRef.current = false;
      lastSnapshottedResultRef.current = 0;
    }
  }, [latestResultTimestamp]);

  useEffect(() => {
    for (const [addr, entry] of Object.entries(decryptedHands)) {
      if (entry.cards.length > 0) {
        liveHandSnapshotsRef.current[addr] = entry;
      }
    }
    if (connectedDecryptedHandState?.cards.length && lowerWalletAddress) {
      liveHandSnapshotsRef.current[lowerWalletAddress] = connectedDecryptedHandState;
    }
  }, [decryptedHands, connectedDecryptedHandState, lowerWalletAddress]);

  useEffect(() => {
    if (latestResultTimestamp === 0 || lastSnapshottedResultRef.current === latestResultTimestamp) {
      return;
    }
    const stamped: Record<string, CachedDecryptedHand> = {};
    for (const [addr, entry] of Object.entries(liveHandSnapshotsRef.current)) {
      if (entry.cards.length === 0) continue;
      stamped[`${latestResultTimestamp}:${addr}`] = {
        cards: entry.cards.map((card) => ({ ...card })),
        total: entry.total,
        signature: entry.signature
      };
    }
    if (Object.keys(stamped).length > 0) {
      setHandSnapshotCache((prev) => ({ ...prev, ...stamped }));
    }
    lastSnapshottedResultRef.current = latestResultTimestamp;
  }, [latestResultTimestamp]);

  const showdownPlayerCards = useMemo(() => {
    if (!table) return new Map<string, { cards: Card[]; total: number }>();
    const results = table.lastHandResult?.results ?? [];
    const map = new Map<string, { cards: Card[]; total: number }>();
    for (const result of results) {
      const total = Number(result.total ?? 0n);
      const key = toLower(result.addr);
      const snapshotKey = key && latestResultTimestamp > 0 ? `${latestResultTimestamp}:${key}` : null;
      const snapshot = snapshotKey ? handSnapshotCache[snapshotKey] : undefined;
      const cached = snapshot ?? (key ? decryptedHands[key] : undefined);
      if (cached && cached.cards.length > 0) {
        map.set(key!, { cards: cached.cards, total: cached.total });
      } else {
        map.set(key!, { cards: [], total });
      }
    }
    return map;
  }, [table, decryptedHands, handSnapshotCache, latestResultTimestamp]);

  const dealerHandForLastResult = useMemo(() => {
    if (latestResultTimestamp === 0) return null;
    const cached = dealerHandByTimestamp[latestResultTimestamp];
    if (cached) return cached;
    if (dealerRevealTimestamp === latestResultTimestamp && dealerPublicHand) {
      return dealerPublicHand;
    }
    return null;
  }, [latestResultTimestamp, dealerHandByTimestamp, dealerRevealTimestamp, dealerPublicHand]);

  // Whenever a snapshot exists, transform it for the UI (fallback to live phase if needed).
  const rawShowdownSummary = useMemo(() => {
    if (!table) return null;

    const lookup = new Map<string, Player>();
    if (baseGameState) {
      for (const player of baseGameState.players) {
        const key = toLower(player.address);
        if (key) lookup.set(key, player);
      }
    }

    const summary = toShowdownSummaryFromHand(
      Number(table.id),
      table.lastHandResult,
      lookup,
      dealerHandForLastResult?.cards
    );
    if (summary) return summary;

    if (baseGameState && baseGameState.phase === 'showdown') {
      return summarizeShowdown(baseGameState);
    }

    return null;
  }, [table, baseGameState, dealerHandForLastResult]);

  const betweenHands = useMemo(() => {
    if (baseGameState) {
      return baseGameState.phase === 'betting';
    }
    if (table) {
      return table.phase === GamePhase.WaitingForPlayers;
    }
    return false;
  }, [baseGameState, table]);

  // True until the latest stored snapshot has been acknowledged locally.
  const awaitingNextHand = useMemo(() => {
    if (!rawShowdownSummary) return false;
    if (latestResultTimestamp === 0) return false;
    if (!betweenHands) return false;
    return latestResultTimestamp !== acknowledgedResultTimestamp;
  }, [rawShowdownSummary, latestResultTimestamp, acknowledgedResultTimestamp, betweenHands]);

  const isShowdownPhase = useMemo(() => {
    if (baseGameState?.phase === 'showdown') return true;
    if (table && table.phase === GamePhase.Showdown) return true;
    return false;
  }, [baseGameState?.phase, table]);

  useEffect(() => {
    if (latestResultTimestamp === 0 || !rawShowdownSummary) return;
    if (dealerHandByTimestamp[latestResultTimestamp]) return;
    if (dealerPublicHand && lastDealerResultTimestampRef.current === latestResultTimestamp) return;
    if (dealerDecryptBlockedRef.current) return;
    setDealerDecryptState((prev) => (prev === 'pending' ? prev : 'pending'));
  }, [latestResultTimestamp, rawShowdownSummary, dealerHandByTimestamp, dealerPublicHand]);

  // Only surface the showdown summary while we are paused between hands.
  const showdownResult = useMemo(() => {
    if (!awaitingNextHand) return null;
    return rawShowdownSummary;
  }, [awaitingNextHand, rawShowdownSummary]);

  const lastHandSummary = rawShowdownSummary;

  const refreshTableActivity = useCallback(async () => {
    try {
      const activity = await fetchTableActivity(tableId);
      setTableActivity(activity);
    } catch (err) {
      logTechnicalError('[BlackjackGame] table activity fetch failed', err, {
        tableId: tableId.toString(),
        baseUrl: getTableActivityBaseUrl()
      });
    }
  }, [tableId]);

  useEffect(() => {
    void refreshTableActivity();
  }, [refreshTableActivity]);

  const displayTableActivity = useMemo(
    () => mergeLatestHandActivity(tableActivity, table?.lastHandResult),
    [tableActivity, table?.lastHandResult]
  );

  useEffect(() => {
    if (!table) {
      setAcknowledgedResultTimestamp(0);
      return;
    }
  }, [tableId, table]);

  useEffect(() => {
    if (tablesCount !== undefined) {
      devLog('[BlackjackGame] Tables count updated', tablesCount);
    }
  }, [tablesCount]);

  useEffect(() => {
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const clearRetryTimer = () => {
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
    };

    const resetPending = () => {
      playerDecryptInFlightRef.current = null;
    };

    const run = async () => {
      if (cancelled) return;

      if (playerDecryptState !== 'pending') {
        resetPending();
        clearRetryTimer();
        return;
      }

      if (playerDecryptBlockedRef.current) {
        resetPending();
        clearRetryTimer();
        return;
      }

      if (playerDecryptState === 'error') {
        resetPending();
        clearRetryTimer();
        return;
      }

      if (!walletAddress || !contractAddress || !publicClient || !baseGameState) {
        if (!walletAddress) {
          setDecryptedHands({});
          lastPlayerHandSignatureRef.current = '0';
          setConnectedDecryptedHandState(undefined);
        }
        playerDecryptErrorRef.current = null;
        setPlayerDecryptState('idle');
        resetPending();
        clearRetryTimer();
        return;
      }

      if (!lowerWalletAddress) {
        resetPending();
        clearRetryTimer();
        return;
      }

      const lower = lowerWalletAddress;
      const player = baseGameState.players.find((entry) => toLower(entry.address) === lower);
      const expectedCardCount = player?.hand.length ?? 0;

      if (!player || expectedCardCount === 0) {
        setDecryptedHands((prev) => {
          if (!(lower in prev)) return prev;
          const next = { ...prev };
          delete next[lower];
          return next;
        });
        if (lower === lowerWalletAddress) {
          setConnectedDecryptedHandState(undefined);
        }
        playerDecryptErrorRef.current = null;
        setPlayerDecryptState('idle');
        lastPlayerHandSignatureRef.current = '0';
        resetPending();
        clearRetryTimer();
        return;
      }

      const currentHandSignature = playerHandSignature;
      if (failedPlayerHandSignatureRef.current && failedPlayerHandSignatureRef.current !== currentHandSignature) {
        failedPlayerHandSignatureRef.current = null;
      }

      const decryptedMatchesHand =
        Boolean(
          playerDecryptedHand &&
          playerDecryptedHand.cards.length === expectedCardCount &&
          lastPlayerHandSignatureRef.current === currentHandSignature
        );

      if (decryptedMatchesHand) {
        resetPending();
        clearRetryTimer();
        if (playerDecryptState !== 'success') {
          setPlayerDecryptState('success');
          playerDecryptBlockedRef.current = false;
        }
        return;
      }

      if (failedPlayerHandSignatureRef.current === currentHandSignature) {
        resetPending();
        clearRetryTimer();
        if (playerDecryptState !== 'error') {
          setPlayerDecryptState('error');
        }
        return;
      }

      if (
        lastPlayerAttemptedSignatureRef.current === currentHandSignature &&
        playerDecryptState !== 'pending'
      ) {
        resetPending();
        clearRetryTimer();
        return;
      }

      if (playerDecryptInFlightRef.current === currentHandSignature && playerDecryptState === 'pending') {
        return;
      }

      playerDecryptInFlightRef.current = currentHandSignature;
      lastPlayerAttemptedSignatureRef.current = currentHandSignature;
      failedPlayerHandSignatureRef.current = null;
      setPlayerDecryptState((prev) => (prev === 'pending' ? prev : 'pending'));

      devLog('[BlackjackGame] Player decrypt attempt', {
        tableId: tableId.toString(),
        player: lower,
        handSignature: currentHandSignature,
        handSize: expectedCardCount,
        decryptedSize: playerDecryptedHand?.cards.length ?? 0
      });

      let rankHandles: `0x${string}`[] = [];
      let suitHandles: `0x${string}`[] = [];
      let handleSignature: string | null = null;

      const cachedHandles = playerHandleCacheRef.current.get(currentHandSignature);
      if (cachedHandles) {
        rankHandles = [...cachedHandles.rank];
        suitHandles = [...cachedHandles.suit];
        handleSignature = cachedHandles.signature;
      } else {
        let fetchError: unknown = null;
        for (let attempt = 0; attempt < HANDLE_RETRY_LIMIT; attempt++) {
          if (cancelled) return;
          devLog('[BlackjackGame] Fetching player encrypted handles', {
            tableId: tableId.toString(),
            player: lower,
            expectedCardCount
          });
          try {
            const response = await publicClient.readContract({
              ...blackjackContract,
              functionName: 'getPlayerEncryptedHandles',
              args: [tableId, walletAddress] as const
            });

            [rankHandles, suitHandles] = response as readonly [`0x${string}`[], `0x${string}`[]];
            if (Array.isArray(rankHandles) && rankHandles.length > 0) {
              if (expectedCardCount > 0 && rankHandles.length < expectedCardCount) {
                devLog('[BlackjackGame] Handle fetch incomplete, retrying', {
                  tableId: tableId.toString(),
                  player: lower,
                  expectedCardCount,
                  fetched: rankHandles.length
                });
                rankHandles = [];
                suitHandles = [];
              } else {
                handleSignature = `${tableId.toString()}::${lower}::${rankHandles.join('|')}::${suitHandles.join('|')}`;
                devLog('[BlackjackGame] Player handles fetched', {
                  tableId: tableId.toString(),
                  player: lower,
                  rankCount: rankHandles.length,
                  suitCount: suitHandles.length,
                  handleSignature
                });
                playerHandleCacheRef.current.set(currentHandSignature, {
                  rank: [...rankHandles],
                  suit: [...suitHandles],
                  signature: handleSignature
                });
                break;
              }
            }
          } catch (error) {
            fetchError = error;
            break;
          }

          if (attempt < HANDLE_RETRY_LIMIT - 1) {
            await sleep(HANDLE_RETRY_DELAY_MS * (attempt + 1));
          }
        }

        if (fetchError) {
          logTechnicalError('[BlackjackGame] Failed to load encrypted handles', fetchError, {
            tableId: tableId.toString(),
            player: lower,
            handSignature: currentHandSignature
          });
          if (!cancelled) {
            if (playerDecryptErrorRef.current !== currentHandSignature) {
              playerDecryptErrorRef.current = currentHandSignature;
              toast.error('Could not load your cards', {
                description: 'Check your connection and try again.'
              });
            }
            failedPlayerHandSignatureRef.current = currentHandSignature;
            setPlayerDecryptState('error');
            lastPlayerDecryptErrorAtRef.current = Date.now();
            if (isAuthError(fetchError)) {
              playerDecryptBlockedRef.current = true;
            }
          }
          resetPending();
          clearRetryTimer();
          return;
        }
      }

      if (!Array.isArray(rankHandles) || rankHandles.length === 0) {
        resetPending();
        clearRetryTimer();
        retryTimer = setTimeout(() => {
          devLog('[BlackjackGame] Retrying handle fetch after empty response', {
            tableId: tableId.toString(),
            player: lower,
            handSignature: currentHandSignature
          });
          if (!cancelled) {
            run();
          }
        }, HANDLE_RETRY_DELAY_MS * HANDLE_RETRY_LIMIT);
        return;
      }

      if (handleSignature) {
        if (
          handleSignature === lastPlayerHandleSignatureRef.current &&
          playerDecryptedHand &&
          playerDecryptedHand.cards.length === player.hand.length
        ) {
          lastPlayerHandSignatureRef.current = currentHandSignature;
          resetPending();
          setPlayerDecryptState('success');
          return;
        }

        const cached = playerDecryptCacheRef.current.get(handleSignature);
        if (cached && cached.cards.length === expectedCardCount) {
          if (!cancelled) {
            const cachedCards = cached.cards.map((card) => ({ ...card }));
            setDecryptedHands((prev) => ({
              ...prev,
              [lower]: { cards: cachedCards, total: cached.total, signature: currentHandSignature }
            }));
            if (lower === lowerWalletAddress) {
              setConnectedDecryptedHandState({
                cards: cachedCards.map((card) => ({ ...card })),
                total: cached.total,
                signature: currentHandSignature
              });
            }
            playerDecryptErrorRef.current = null;
            setPlayerDecryptState('success');
            lastPlayerHandleSignatureRef.current = handleSignature;
            lastPlayerHandSignatureRef.current = currentHandSignature;
            playerDecryptBlockedRef.current = false;
          }
          resetPending();
          clearRetryTimer();
          return;
        }
      }

      let scheduledHandleRetry = false;
      let activeSignature: StoredDecryptionSignature | null = null;
      try {
        const fhe = await ensureFhevmInstance();

        const signingContext = await (async () => {
          try {
            const browserProvider = await getBrowserProvider();
            return { browserProvider };
          } catch (error) {
            if (walletClient) {
              return { walletClient };
            }
            return null;
          }
        })();

        if (!signingContext) {
          devWarn('[BlackjackGame] No signing provider available for decryption');
          playerDecryptErrorRef.current = currentHandSignature;
          toast.error('Wallet approval required', {
            description: 'Reconnect your wallet and approve the prompt to view your cards.'
          });
          setPlayerDecryptState('error');
          lastPlayerDecryptErrorAtRef.current = Date.now();
          playerDecryptBlockedRef.current = true;
          playerDecryptInFlightRef.current = null;
          clearRetryTimer();
          return;
        }

        const signature = await loadOrCreateSignature(
          fhe,
          contractAddress as `0x${string}`,
          signingContext
        );
        activeSignature = signature;

        const queries = [...rankHandles, ...suitHandles].map((handle) => ({
          handle: hexlifyHandle(handle),
          contractAddress: contractAddress as `0x${string}`
        }));

        const decrypted = await fhe.userDecrypt(
          queries,
          signature.privateKey,
          signature.publicKey,
          signature.signature,
          signature.contractAddresses,
          signature.userAddress,
          signature.startTimestamp,
          signature.durationDays
        );

        const ranks = rankHandles.map((handle) => Number(decrypted[hexlifyHandle(handle)]));
        const suits = suitHandles.map((handle) => Number(decrypted[hexlifyHandle(handle)]));

        if (ranks.length !== suits.length) {
          throw new Error('Encrypted rank/suit handle count mismatch');
        }

        const cards = ranks.map((rank, index) => {
          const rankValue = Number.isFinite(rank) ? rank : 0;
          const suitValue = Number.isFinite(suits[index]) ? suits[index] : 0;
          return toUiCard(rankValue, suitValue, index);
        });
        const total = calculateHandValue(cards);
        if (!cancelled && expectedCardCount > 0 && cards.length < expectedCardCount) {
          devLog('[BlackjackGame] Decrypt yielded fewer cards than expected, retrying', {
            tableId: tableId.toString(),
            player: lower,
            expectedCount: expectedCardCount,
            decryptedCount: cards.length
          });
          scheduledHandleRetry = true;
          playerDecryptInFlightRef.current = null;
          failedPlayerHandSignatureRef.current = null;
          retryTimer = setTimeout(() => {
            if (!cancelled) {
              run();
            }
          }, HANDLE_RETRY_DELAY_MS * (HANDLE_RETRY_LIMIT + 1));
          return;
        }

        if (!cancelled) {
          devLog('[BlackjackGame] Player decrypt result', {
            tableId: tableId.toString(),
            player: lower,
            handSignature: currentHandSignature,
            ranks,
            suits,
            cardCount: cards.length,
            total
          });
          setDecryptedHands((prev) => {
            const nextCards = cards.map((card) => ({ ...card }));
            return {
              ...prev,
              [lower]: { cards: nextCards, total, signature: currentHandSignature }
            };
          });
          if (lower === lowerWalletAddress) {
            const stateCards = cards.map((card) => ({ ...card }));
            setConnectedDecryptedHandState({ cards: stateCards, total, signature: currentHandSignature });
          }
          playerDecryptErrorRef.current = null;
          failedPlayerHandSignatureRef.current = null;
          setPlayerDecryptState('success');
          lastPlayerHandleSignatureRef.current = handleSignature;
          lastPlayerHandSignatureRef.current = currentHandSignature;
          playerDecryptBlockedRef.current = false;
          if (handleSignature) {
            playerDecryptCacheRef.current.set(handleSignature, {
              cards: cards.map((card) => ({ ...card })),
              total
            });
          }
        }
      } catch (error) {
        logTechnicalError('[BlackjackGame] Failed to decrypt player hand', error, {
          tableId: tableId.toString(),
          player: lower,
          handSignature: currentHandSignature,
          expectedCardCount
        });
        if (!cancelled) {
          setDecryptedHands((prev) => {
            if (!(lower in prev)) return prev;
            const next = { ...prev };
            delete next[lower];
            return next;
          });
          if (activeSignature && shouldResetDecryptSignature(error)) {
            const contractForSignature = activeSignature.contractAddresses[0];
            if (contractForSignature) {
              invalidateStoredSignature(contractForSignature, activeSignature.userAddress);
            }
          }
          if (playerDecryptErrorRef.current !== playerHandSignature) {
            playerDecryptErrorRef.current = playerHandSignature;
            toast.error('Could not reveal your cards', {
              description: 'Approve the wallet prompt if asked, then try again.'
            });
          }
          devWarn('[BlackjackGame] Player decrypt failed', {
            tableId: tableId.toString(),
            player: lower,
            handSignature: currentHandSignature,
            expectedCardCount,
            error: (error as Error)?.message ?? error
          });
          setPlayerDecryptState('error');
          lastPlayerDecryptErrorAtRef.current = Date.now();
          if (isAuthError(error)) {
            playerDecryptBlockedRef.current = true;
          }
          lastPlayerHandleSignatureRef.current = null;
          failedPlayerHandSignatureRef.current = currentHandSignature;
          lastPlayerAttemptedSignatureRef.current = currentHandSignature;
        }
      } finally {
        if (!scheduledHandleRetry) {
          resetPending();
          clearRetryTimer();
        }
      }
    };

    run();

    return () => {
      cancelled = true;
      playerDecryptInFlightRef.current = null;
      if (retryTimer) {
        clearTimeout(retryTimer);
      }
    };
  }, [
    walletAddress,
    lowerWalletAddress,
    contractAddress,
    publicClient,
    walletClient,
    tableId,
    baseGameState,
    playerHandSignature,
    playerDecryptedHand,
    playerDecryptState
  ]);

  useEffect(() => {
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const clearRetryTimer = () => {
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
    };

    const resetPending = () => {
      dealerDecryptInFlightRef.current = null;
    };

    const run = async () => {
      let scheduledDealerRetry = false;
      if (cancelled) return;

      if (dealerDecryptState !== 'pending') {
        resetPending();
        clearRetryTimer();
        return;
      }

      if (dealerDecryptBlockedRef.current) {
        resetPending();
        clearRetryTimer();
        return;
      }

      const decryptWindow = awaitingNextHand || isShowdownPhase || Boolean(rawShowdownSummary);

      if (!contractAddress || !publicClient || !decryptWindow || latestResultTimestamp === 0) {
        clearRetryTimer();
        resetPending();
        if (!cancelled) {
          setDealerPublicHand(null);
          dealerDecryptErrorRef.current = null;
          setDealerDecryptState('idle');
          lastDealerHandleSignatureRef.current = null;
          lastDealerResultTimestampRef.current = 0;
        }
        return;
      }

      if (
        dealerPublicHand &&
        lastDealerResultTimestampRef.current === latestResultTimestamp &&
        dealerDecryptState !== 'error'
      ) {
        resetPending();
        clearRetryTimer();
        if (dealerDecryptState !== 'success') {
          setDealerDecryptState('success');
        }
        return;
      }

      const shouldAttempt =
        !dealerPublicHand ||
        lastDealerResultTimestampRef.current !== latestResultTimestamp;

      if (!shouldAttempt) {
        return;
      }

      if (dealerDecryptState === 'pending' && dealerDecryptInFlightRef.current === latestResultTimestamp) {
        return;
      }

      dealerDecryptInFlightRef.current = latestResultTimestamp;
      setDealerDecryptState((prev) => (prev === 'pending' ? prev : 'pending'));

      let rankHandles: `0x${string}`[] = [];
      let suitHandles: `0x${string}`[] = [];
      let handleSignature: string | null = null;
      const cachedDealerHandles = dealerHandleCacheRef.current.get(latestResultTimestamp);
      if (cachedDealerHandles) {
        rankHandles = [...cachedDealerHandles.rank];
        suitHandles = [...cachedDealerHandles.suit];
        handleSignature = cachedDealerHandles.signature;
      } else {
        let fetchError: unknown = null;

        for (let attempt = 0; attempt < HANDLE_RETRY_LIMIT; attempt++) {
          if (cancelled) return;

          try {
            const response = await publicClient.readContract({
              ...blackjackContract,
              functionName: 'getLastDealerEncryptedHandles',
              args: [tableId] as const
            });

            [rankHandles, suitHandles] = response as readonly [`0x${string}`[], `0x${string}`[]];
            if (Array.isArray(rankHandles) && rankHandles.length > 0) {
              handleSignature = `${tableId.toString()}::${latestResultTimestamp.toString()}::${rankHandles.join('|')}::${suitHandles.join('|')}`;
              dealerHandleCacheRef.current.set(latestResultTimestamp, {
                rank: [...rankHandles],
                suit: [...suitHandles],
                signature: handleSignature
              });
              break;
            }
          } catch (error) {
            fetchError = error;
            break;
          }

          if (attempt < HANDLE_RETRY_LIMIT - 1) {
            await sleep(HANDLE_RETRY_DELAY_MS * (attempt + 1));
          }
        }

        if (fetchError) {
          logTechnicalError('[BlackjackGame] Failed to load dealer encrypted handles', fetchError, {
            tableId: tableId.toString(),
            resultTimestamp: latestResultTimestamp
          });
          if (!cancelled) {
            if (dealerDecryptErrorRef.current !== latestResultTimestamp) {
              dealerDecryptErrorRef.current = latestResultTimestamp;
              toast.error('Could not reveal dealer cards', {
                description: 'Check your connection and try again.'
              });
            }
            setDealerDecryptState('error');
            lastDealerDecryptErrorAtRef.current = Date.now();
            if (isAuthError(fetchError)) {
              dealerDecryptBlockedRef.current = true;
            }
          }
          resetPending();
          clearRetryTimer();
          return;
        }
      }

      if (!Array.isArray(rankHandles) || rankHandles.length === 0) {
        scheduledDealerRetry = true;
        resetPending();
        retryTimer = setTimeout(() => {
          if (!cancelled) {
            run();
          }
        }, HANDLE_RETRY_DELAY_MS * HANDLE_RETRY_LIMIT);
        return;
      }

      if (handleSignature) {
        if (handleSignature === lastDealerHandleSignatureRef.current && dealerPublicHand) {
          lastDealerResultTimestampRef.current = latestResultTimestamp;
          resetPending();
          setDealerDecryptState('success');
          dealerDecryptBlockedRef.current = false;
          return;
        }

        const cached = dealerDecryptCacheRef.current.get(handleSignature);
        if (cached) {
          if (!cancelled) {
            const cachedCards = cached.cards.map((card) => ({ ...card }));
            const revealed = { cards: cachedCards, total: cached.total };
            setDealerPublicHand(revealed);
            setDealerHandByTimestamp((prev) => ({
              ...prev,
              [latestResultTimestamp]: revealed
            }));
            setDealerRevealTimestamp(latestResultTimestamp);
            dealerDecryptErrorRef.current = null;
            setDealerDecryptState('success');
            lastDealerHandleSignatureRef.current = handleSignature;
            lastDealerResultTimestampRef.current = latestResultTimestamp;
            dealerDecryptBlockedRef.current = false;
          }
          resetPending();
          clearRetryTimer();
          return;
        }
      }

      try {
        const fhe = await ensureFhevmInstance();
        const rankHex = rankHandles.map((handle) => hexlifyHandle(handle));
        const suitHex = suitHandles.map((handle) => hexlifyHandle(handle));
        const decrypted = await fhe.publicDecrypt([...rankHex, ...suitHex]);

        const ranks = rankHex.map((handle) => Number(readClearValue(decrypted, handle)));
        const suits = suitHex.map((handle) => Number(readClearValue(decrypted, handle)));

        if (ranks.length !== suits.length) {
          throw new Error('Dealer rank/suit handle mismatch');
        }

        const cards = ranks.map((rank, index) => {
          const rankValue = Number.isFinite(rank) ? rank : 0;
          const suitValue = Number.isFinite(suits[index]) ? suits[index] : 0;
          return toUiCard(rankValue, suitValue, index);
        });
        if (!hasRevealedCards(cards)) {
          const notReady = ranks.every((rank) => !Number.isFinite(rank) || rank === 0);
          throw new Error(
            notReady
              ? 'Dealer cards are not publicly decryptable yet'
              : 'Dealer decrypt returned invalid card ranks'
          );
        }
        const total = calculateHandValue(cards);

        if (!cancelled) {
          devDebug('[BlackjackGame] Dealer decrypt result', { rankHandles, suitHandles, decrypted });
          const revealed = { cards, total };
          setDealerPublicHand(revealed);
          setDealerHandByTimestamp((prev) => ({
            ...prev,
            [latestResultTimestamp]: {
              cards: cards.map((card) => ({ ...card })),
              total
            }
          }));
          setDealerRevealTimestamp(latestResultTimestamp);
          dealerDecryptErrorRef.current = null;
          setDealerDecryptState('success');
          lastDealerHandleSignatureRef.current = handleSignature;
          lastDealerResultTimestampRef.current = latestResultTimestamp;
          dealerDecryptBlockedRef.current = false;
          if (handleSignature) {
            dealerDecryptCacheRef.current.set(handleSignature, {
              cards: cards.map((card) => ({ ...card })),
              total
            });
          }
        }
      } catch (error) {
        logTechnicalError('[BlackjackGame] Failed to decrypt dealer hand', error, {
          tableId: tableId.toString(),
          resultTimestamp: latestResultTimestamp
        });
        if (!cancelled) {
          const errorMessage = extractErrorMessage(error);
          const awaitingPublicDecrypt =
            /not publicly decryptable yet|not_ready_for_decryption/i.test(errorMessage);

          if (awaitingPublicDecrypt) {
            scheduledDealerRetry = true;
            resetPending();
            retryTimer = setTimeout(() => {
              if (!cancelled) {
                setDealerDecryptState('pending');
              }
            }, HANDLE_RETRY_DELAY_MS * 2);
            return;
          }

          const cachedReveal = dealerHandByTimestamp[latestResultTimestamp];
          if (cachedReveal) {
            setDealerPublicHand(cachedReveal);
          } else {
            setDealerPublicHand(null);
            lastDealerResultTimestampRef.current = 0;
          }
          if (dealerDecryptErrorRef.current !== latestResultTimestamp) {
            dealerDecryptErrorRef.current = latestResultTimestamp;
            toast.error('Could not reveal dealer cards', {
              description: 'Check your connection and try again.'
            });
          }
          setDealerDecryptState('error');
          lastDealerDecryptErrorAtRef.current = Date.now();
          lastDealerHandleSignatureRef.current = null;
        }
      } finally {
        if (!scheduledDealerRetry) {
          resetPending();
          clearRetryTimer();
        }
      }
    };

    run();

    return () => {
      cancelled = true;
      dealerDecryptInFlightRef.current = null;
      if (retryTimer) {
        clearTimeout(retryTimer);
      }
    };
  }, [
    contractAddress,
    publicClient,
    tableId,
    awaitingNextHand,
    isShowdownPhase,
    rawShowdownSummary,
    latestResultTimestamp,
    dealerDecryptState,
    dealerPublicHand,
    dealerHandByTimestamp
  ]);

  useEffect(() => {
    if (!baseGameState) {
      return;
    }

    const player = lowerWalletAddress
      ? baseGameState.players.find((entry) => toLower(entry.address) === lowerWalletAddress)
      : undefined;
    const expectedCardCount = player?.hand.length ?? 0;
    const decryptedCount = playerDecryptedHand?.cards.length ?? 0;

    if (expectedCardCount === 0) {
      if (playerDecryptState !== 'idle') {
        setPlayerDecryptState('idle');
      }
      return;
    }

    if (decryptedCount >= expectedCardCount && playerDecryptState !== 'success') {
      setPlayerDecryptState('success');
    }
  }, [baseGameState, lowerWalletAddress, playerDecryptedHand, playerDecryptState]);

  useEffect(() => {
    if (table) {
      devLog('[BlackjackGame] Table state updated', {
        tableId,
        phase: table.phase,
        lastActivityTimestamp: table.lastActivityTimestamp,
        latestResultTimestamp
      });
    }
  }, [table, tableId, latestResultTimestamp]);

  useEffect(() => {
    if (playerDecryptState === 'error' && !playerDecryptBlockedRef.current) {
      if (!playerDecryptRetryTimeoutRef.current) {
        const elapsed = Date.now() - lastPlayerDecryptErrorAtRef.current;
        const delayMs = Math.max(PLAYER_DECRYPT_RETRY_DELAY_MS - Math.max(elapsed, 0), 0);
        playerDecryptRetryTimeoutRef.current = setTimeout(() => {
          playerDecryptRetryTimeoutRef.current = null;
          setPlayerDecryptState((prev) => (prev === 'error' ? 'pending' : prev));
        }, delayMs > 0 ? delayMs : 1);
      }
    } else if (playerDecryptRetryTimeoutRef.current) {
      clearTimeout(playerDecryptRetryTimeoutRef.current);
      playerDecryptRetryTimeoutRef.current = null;
    }
  }, [playerDecryptState]);

  useEffect(() => {
    if (dealerDecryptState === 'error' && !dealerDecryptBlockedRef.current) {
      if (!dealerDecryptRetryTimeoutRef.current) {
        const elapsed = Date.now() - lastDealerDecryptErrorAtRef.current;
        const delayMs = Math.max(DEALER_DECRYPT_RETRY_DELAY_MS - Math.max(elapsed, 0), 0);
        dealerDecryptRetryTimeoutRef.current = setTimeout(() => {
          dealerDecryptRetryTimeoutRef.current = null;
          setDealerDecryptState((prev) => (prev === 'error' ? 'pending' : prev));
        }, delayMs > 0 ? delayMs : 1);
      }
    } else if (dealerDecryptRetryTimeoutRef.current) {
      clearTimeout(dealerDecryptRetryTimeoutRef.current);
      dealerDecryptRetryTimeoutRef.current = null;
    }
  }, [dealerDecryptState]);

  useEffect(() => {
    if (!baseGameState || !lowerWalletAddress) return;
    const player = baseGameState.players.find(
      (entry) => toLower(entry.address) === lowerWalletAddress
    );
    if (!player) {
      if (connectedDecryptedHandState) {
        setConnectedDecryptedHandState(undefined);
      }
      playerDecryptInFlightRef.current = null;
      failedPlayerHandSignatureRef.current = null;
      lastPlayerHandSignatureRef.current = '0';
      lastPlayerAttemptedSignatureRef.current = '0';
      return;
    }

    const expectedCardCount = player.hand.length;
    if (expectedCardCount === 0) {
      if (connectedDecryptedHandState) {
        setConnectedDecryptedHandState(undefined);
      }
      playerDecryptInFlightRef.current = null;
      failedPlayerHandSignatureRef.current = null;
      lastPlayerHandSignatureRef.current = '0';
      lastPlayerAttemptedSignatureRef.current = '0';
      return;
    }

    const lower = lowerWalletAddress;
    const storedRecord = lower ? decryptedHands[lower] : undefined;
    const currentHandSignature = playerHandSignature;
    const resolvedCount = (() => {
      if (connectedDecryptedHandState && connectedDecryptedHandState.signature === currentHandSignature) {
        return connectedDecryptedHandState.cards.length;
      }
      if (playerDecryptedHand) {
        return playerDecryptedHand.cards.length;
      }
      if (storedRecord && storedRecord.signature === currentHandSignature) {
        return storedRecord.cards.length;
      }
      return 0;
    })();

    if (resolvedCount >= expectedCardCount) {
      if (playerDecryptState !== 'success') {
        setPlayerDecryptState('success');
      }
      return;
    }

    const alreadyAttempted =
      lastPlayerHandSignatureRef.current === currentHandSignature &&
      (playerDecryptState === 'success' || playerDecryptInFlightRef.current === currentHandSignature);

    if (alreadyAttempted) {
      return;
    }

    if (connectedDecryptedHandState) {
      setConnectedDecryptedHandState(undefined);
    }
    playerDecryptInFlightRef.current = null;
    failedPlayerHandSignatureRef.current = null;
    lastPlayerHandSignatureRef.current = '0';
    lastPlayerAttemptedSignatureRef.current = '0';
    if (!playerDecryptBlockedRef.current && playerDecryptState !== 'pending') {
      setPlayerDecryptState('pending');
    }
  }, [
    baseGameState,
    connectedDecryptedHandState,
    decryptedHands,
    lowerWalletAddress,
    playerDecryptedHand,
    playerDecryptState,
    playerHandSignature
  ]);

  useEffect(() => {
    return () => {
      if (playerDecryptRetryTimeoutRef.current) {
        clearTimeout(playerDecryptRetryTimeoutRef.current);
        playerDecryptRetryTimeoutRef.current = null;
      }
      if (dealerDecryptRetryTimeoutRef.current) {
        clearTimeout(dealerDecryptRetryTimeoutRef.current);
        dealerDecryptRetryTimeoutRef.current = null;
      }
    };
  }, []);

  const decoratedGameState = useMemo(() => {
    if (!baseGameState) return undefined;

    const players = baseGameState.players.map((player) => {
      const lower = toLower(player.address);
      const isConnectedPlayer = lowerWalletAddress && lower === lowerWalletAddress;
      const snapshotKey = lower && latestResultTimestamp > 0 ? `${latestResultTimestamp}:${lower}` : null;
      const handSnapshot = snapshotKey ? handSnapshotCache[snapshotKey] : undefined;
      const showdown = awaitingNextHand && isConnectedPlayer
        ? (showdownPlayerCards.get(lower) ?? (handSnapshot
          ? { cards: handSnapshot.cards, total: handSnapshot.total }
          : undefined))
        : undefined;
      let decryptedSource: CachedDecryptedHand | undefined;
      if (isConnectedPlayer) {
        if (connectedDecryptedHandState && connectedDecryptedHandState.signature === playerHandSignature) {
          decryptedSource = connectedDecryptedHandState;
        } else if (playerDecryptedHand) {
          decryptedSource = playerDecryptedHand;
        } else if (lower) {
          const fallback = decryptedHands[lower];
          decryptedSource = fallback && fallback.signature === playerHandSignature ? fallback : undefined;
        }
      } else if (lower) {
        decryptedSource = decryptedHands[lower];
      }

      const baseHandLength = player.hand.length;
      let displayHand: Card[] = player.displayHand;
      let displayTotal: number | null = player.displayTotal;
      let cardsRevealed = player.cardsRevealed;

      if (showdown && showdown.cards.length > 0) {
        displayHand = showdown.cards.map((card) => ({ ...card }));
        displayTotal = showdown.total;
        cardsRevealed = true;
      } else if (awaitingNextHand && handSnapshot && handSnapshot.cards.length > 0) {
        displayHand = handSnapshot.cards.map((card) => ({ ...card }));
        displayTotal = handSnapshot.total;
        cardsRevealed = true;
      } else if (decryptedSource) {
        const combined = decryptedSource.cards.slice(0, baseHandLength).map((card) => ({ ...card }));
        const hasFullDecrypt =
          baseHandLength > 0 && decryptedSource.cards.length >= baseHandLength;
        for (let index = combined.length; index < baseHandLength; index++) {
          combined.push(toHiddenCard(index, player.id));
        }
        displayHand = combined;
        displayTotal = hasFullDecrypt ? decryptedSource.total : null;
        cardsRevealed = hasFullDecrypt;
      } else {
        displayHand = player.hand.map((_, index) => toHiddenCard(index, player.id));
        displayTotal = null;
        cardsRevealed = false;
      }

      const resolvedTotal =
        displayTotal ??
        (cardsRevealed ? calculateHandValue(displayHand) : null);

      const tablePlayer = table?.players.find(
        (entry) => toLower(entry.addr) === lower
      );
      const chainBusted = Boolean(tablePlayer?.busted);

      let bet = player.bet;
      let hasActed = player.hasActed;
      let isActive = player.isActive;
      if (isConnectedPlayer && optimisticOverlay) {
        if (optimisticOverlay.bet !== undefined) {
          bet = Number(optimisticOverlay.bet);
        }
        if (optimisticOverlay.hasActed) {
          hasActed = true;
        }
      }

      const chainPendingKind = table ? (Number(table.pendingKind) as PendingKind) : PendingKind.None;
      const effectivePendingKind =
        chainPendingKind !== PendingKind.None
          ? chainPendingKind
          : optimisticOverlay?.pendingKind ?? PendingKind.None;
      const tablePendingPlayer = table?.pendingPlayer?.toLowerCase();
      const effectivePendingPlayer =
        tablePendingPlayer && tablePendingPlayer !== ZERO_ADDRESS
          ? tablePendingPlayer
          : optimisticOverlay?.pendingPlayer ?? null;
      const pendingDealForPlayer =
        isConnectedPlayer &&
        effectivePendingKind !== PendingKind.None &&
        (effectivePendingKind === PendingKind.Hit || effectivePendingKind === PendingKind.DoubleDown) &&
        effectivePendingPlayer === lower;

      const bustOptions = {
        chainBusted,
        cardsFullyRevealed: cardsRevealed,
        pendingDealForPlayer,
        requireRevealedCards: isConnectedPlayer
      };
      const resolvedBust = resolvePlayerBust({ ...player, chainBusted }, resolvedTotal, bustOptions);

      return {
        ...player,
        bet,
        hasActed,
        isActive,
        displayHand,
        displayTotal: resolvedTotal,
        cardsRevealed,
        bust: resolvedBust,
        stand: player.stand && !resolvedBust
      };
    });

    let dealerDisplayHand = baseGameState.dealer.displayHand;
    let dealerDisplayTotal = baseGameState.dealer.displayTotal;
    let dealerCardsRevealed = baseGameState.dealer.cardsRevealed;

    if ((awaitingNextHand || baseGameState.phase === 'showdown') && dealerPublicHand) {
      dealerDisplayHand = dealerPublicHand.cards;
      dealerDisplayTotal = dealerPublicHand.total;
      dealerCardsRevealed = true;
    }

    const activePlayerIndex = players.findIndex(
      (player) => player.isActive && !player.hasActed && !player.bust
    );

    return {
      ...baseGameState,
      players,
      activePlayerIndex,
      dealer: {
        ...baseGameState.dealer,
        displayHand: dealerDisplayHand,
        displayTotal: dealerCardsRevealed
          ? dealerDisplayTotal ?? calculateHandValue(baseGameState.dealer.hand)
          : null,
        cardsRevealed: dealerCardsRevealed
      }
    } satisfies GameState;
  }, [
    awaitingNextHand,
    baseGameState,
    dealerPublicHand,
    decryptedHands,
    handSnapshotCache,
    latestResultTimestamp,
    showdownPlayerCards,
    lowerWalletAddress,
    playerDecryptedHand,
    connectedDecryptedHandState,
    playerHandSignature,
    table,
    optimisticOverlay
  ]);

  const gameState = decoratedGameState;

  const connectedPlayer = useMemo(() => {
    if (!gameState || !walletAddress) return undefined;
    return gameState.players.find(
      (player) => toLower(player.address) === toLower(walletAddress)
    );
  }, [gameState, walletAddress]);

  const isSeated = useMemo(() => {
    if (!currentTableId) return false;
    return currentTableId === tableId;
  }, [currentTableId, tableId]);

  const hasActiveSeat = useMemo(() => Boolean(currentTableId && currentTableId !== 0n), [currentTableId]);

  const pendingOracleKind = useMemo(() => {
    const chainKind = table ? (Number(table.pendingKind) as PendingKind) : PendingKind.None;
    if (chainKind !== PendingKind.None) return chainKind;
    return optimisticOverlay?.pendingKind ?? PendingKind.None;
  }, [table, optimisticOverlay]);

  const pendingOraclePlayer = useMemo(() => {
    if (table?.pendingPlayer) {
      const lower = table.pendingPlayer.toLowerCase();
      if (lower !== ZERO_ADDRESS) return lower;
    }
    return optimisticOverlay?.pendingPlayer ?? null;
  }, [table?.pendingPlayer, optimisticOverlay]);

  const oraclePending = useMemo(() => pendingOracleKind !== PendingKind.None, [pendingOracleKind]);

  const oraclePendingForSelf = useMemo(() => {
    if (!oraclePending || !pendingOraclePlayer || !lowerWalletAddress) return false;
    return pendingOraclePlayer === lowerWalletAddress;
  }, [oraclePending, pendingOraclePlayer, lowerWalletAddress]);

  const turnTimer = useMemo(() => {
    if (!table || table.phase !== GamePhase.PlayerTurns || oraclePending) return null;
    const waitingPlayer = table.players.some(
      (player) => player.bet > 0n && player.isActive && !player.hasActed && !player.busted
    );
    if (!waitingPlayer) return null;
    const turnTimeoutSeconds = Number(turnTimeoutRaw ?? 60n);
    const lastActivity = Number(table.lastActivityTimestamp);
    const deadlineMs = (lastActivity + turnTimeoutSeconds) * 1_000;
    const secondsRemaining = Math.max(0, Math.ceil((deadlineMs - turnTimerTick) / 1_000));
    return { secondsRemaining, turnTimeoutSeconds };
  }, [table, turnTimeoutRaw, turnTimerTick, oraclePending]);

  const oracleConfirmingBust = useMemo(() => {
    if (!oraclePending || !table) return false;
    if (pendingOracleKind !== PendingKind.Hit && pendingOracleKind !== PendingKind.DoubleDown) {
      return false;
    }
    if (!pendingOraclePlayer) return false;
    const tablePlayer = table.players.find(
      (entry) => entry.addr.toLowerCase() === pendingOraclePlayer
    );
    return Boolean(tablePlayer?.busted);
  }, [oraclePending, pendingOracleKind, pendingOraclePlayer, table]);

  const tableStuck = useMemo(() => {
    if (!table || table.phase !== GamePhase.PlayerTurns || oraclePending) return false;
    const waiting = table.players.some(
      (player) => player.bet > 0n && player.isActive && !player.hasActed && !player.busted
    );
    if (waiting) return false;
    const activeBettors = table.players.filter((player) => player.bet > 0n && player.isActive);
    if (activeBettors.length > 0) {
      return activeBettors.every((player) => player.hasActed);
    }
    return table.players.some((player) => player.bet > 0n);
  }, [table, oraclePending]);

  const walletChipBalance = walletChips as bigint | undefined;

  const chainSelfBusted = useMemo(() => {
    if (!table || !lowerWalletAddress) return false;
    const self = table.players.find((player) => toLower(player.addr) === lowerWalletAddress);
    return Boolean(self?.busted);
  }, [table, lowerWalletAddress]);

  const effectivePlayerTurn = useMemo(() => {
    if (!playerTurn) return false;
    if (connectedPlayer?.bust) return false;
    if (chainSelfBusted) return false;
    return true;
  }, [playerTurn, connectedPlayer?.bust, chainSelfBusted]);

  const guardPlayerAction = useCallback((): boolean => {
    if (connectedPlayer?.bust || chainSelfBusted) {
      toast.info('You busted — the table advances automatically.');
      return false;
    }
    if (
      oraclePending &&
      lowerWalletAddress &&
      pendingOraclePlayer === lowerWalletAddress &&
      (pendingOracleKind === PendingKind.Hit || pendingOracleKind === PendingKind.DoubleDown)
    ) {
      toast.info('Your last card is being dealt. Please wait.');
      return false;
    }
    if (!effectivePlayerTurn) {
      toast.info('It is not your turn.');
      return false;
    }
    return true;
  }, [
    chainSelfBusted,
    connectedPlayer?.bust,
    effectivePlayerTurn,
    lowerWalletAddress,
    oraclePending,
    pendingOracleKind,
    pendingOraclePlayer
  ]);

  const refetchCore = useCallback(async () => {
    devLog('[BlackjackGame] Core refetch triggered');
    await Promise.allSettled([
      refetchTable(),
      refetchHandResult(),
      refetchTurnStatus()
    ]);
    devLog('[BlackjackGame] Core refetch completed');
  }, [refetchTable, refetchHandResult, refetchTurnStatus]);

  const refetchAncillary = useCallback(async () => {
    devLog('[BlackjackGame] Ancillary refetch triggered');
    await Promise.allSettled([
      refetchTablesCount(),
      refetchWalletChips(),
      refetchWithdrawableChips(),
      refetchClaimStatus(),
      refetchPlayerTable()
    ]);
    devLog('[BlackjackGame] Ancillary refetch completed');
  }, [
    refetchClaimStatus,
    refetchPlayerTable,
    refetchTablesCount,
    refetchWalletChips,
    refetchWithdrawableChips
  ]);

  // Batch refetch helper for post-transaction refreshes.
  const refetchAll = useCallback(async () => {
    await Promise.allSettled([refetchCore(), refetchAncillary()]);
  }, [refetchCore, refetchAncillary]);

  const scheduleCoreRefetch = useCallback(() => {
    if (refetchTimerRef.current) {
      clearTimeout(refetchTimerRef.current);
    }
    refetchTimerRef.current = setTimeout(() => {
      refetchTimerRef.current = null;
      void refetchCore();
    }, 50);
  }, [refetchCore]);

  useEffect(() => {
    return () => {
      if (refetchTimerRef.current) {
        clearTimeout(refetchTimerRef.current);
        refetchTimerRef.current = null;
      }
    };
  }, []);

  // Standardised toast/error logging so all writes behave consistently.
  const handleError = useCallback((error: unknown, fallback: string) => {
    logTechnicalError(fallback, error);
    toast.error(fallback, { description: describeUserFacingError(error) });
  }, []);

  // Ensure every action has both signer and contract configured.
  const requireWallet = useCallback(() => {
    if (!walletAddress) {
      toast.error('Connect your wallet to interact with the table.');
      return false;
    }
    if (!contractAddress) {
      logTechnicalError(
        '[BlackjackGame] Blackjack contract address is not configured',
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
  }, [walletAddress, contractAddress, chainId]);

  const waitForReceipt = useCallback(
    async (hash: `0x${string}`) => {
      if (!publicClient) return null;
      return waitForTxReceipt(publicClient, hash);
    },
    [publicClient]
  );

  type RefreshMode = 'auto' | 'core' | 'all' | 'none';

  const retryPlayerDecrypt = useCallback(() => {
    if (!walletAddress || !contractAddress) {
      toast.error('Connect your wallet to retry decryption.');
      return;
    }
    failedPlayerHandSignatureRef.current = null;
    lastPlayerAttemptedSignatureRef.current = '0';
    playerDecryptInFlightRef.current = null;
    playerDecryptBlockedRef.current = false;
    setPlayerDecryptState('pending');
  }, [walletAddress, contractAddress]);

  const retryDealerDecrypt = useCallback(() => {
    dealerDecryptInFlightRef.current = null;
    dealerDecryptBlockedRef.current = false;
    dealerDecryptErrorRef.current = null;
    lastDealerHandleSignatureRef.current = null;
    setDealerDecryptState('pending');
  }, []);

  const resetDecryption = useCallback(() => {
    if (walletAddress && contractAddress) {
      invalidateStoredSignature(contractAddress, walletAddress);
    }
    playerDecryptBlockedRef.current = false;
    dealerDecryptBlockedRef.current = false;
    retryPlayerDecrypt();
    retryDealerDecrypt();
  }, [contractAddress, retryDealerDecrypt, retryPlayerDecrypt, walletAddress]);

  const refetchAfterWrite = useCallback(
    async (mode: RefreshMode = 'auto') => {
      let target: RefreshMode = mode;
      if (target === 'auto') {
        target = supportsFilters ? 'core' : 'all';
      }

      if (target === 'none') return;
      if (target === 'core') {
        await refetchCore();
        return;
      }

      await refetchAll();
    },
    [refetchAll, refetchCore, supportsFilters]
  );

  const applyOptimisticAction = useCallback(
    (functionName: string, args: readonly unknown[]) => {
      if (!lowerWalletAddress) return;
      setAggressivePollUntil(Date.now() + AGGRESSIVE_POLL_DURATION_MS);

      if (functionName === 'placeBet') {
        const amount = args[1] as bigint | undefined;
        setOptimisticOverlay({ bet: amount });
        return;
      }
      if (functionName === 'hit') {
        setOptimisticOverlay({
          pendingKind: PendingKind.Hit,
          pendingPlayer: lowerWalletAddress
        });
        return;
      }
      if (functionName === 'stand') {
        setOptimisticOverlay({
          pendingKind: PendingKind.Stand,
          pendingPlayer: lowerWalletAddress,
          hasActed: true
        });
        return;
      }
      if (functionName === 'doubleDown') {
        setOptimisticOverlay({
          pendingKind: PendingKind.DoubleDown,
          pendingPlayer: lowerWalletAddress
        });
      }
    },
    [lowerWalletAddress]
  );

  // Shared execution helper around wagmi's `writeContractAsync`.
  const execute = useCallback(
    async (
      params: {
        functionName: Parameters<typeof writeBlackjackContract>[0]['functionName'];
        args?: readonly unknown[];
        value?: bigint;
      },
      successMessage?: string,
      refreshMode: RefreshMode = 'auto'
    ): Promise<boolean> => {
      const { functionName, args = [], value } = params;
      if (!requireWallet()) return false;
      if (!publicClient || !walletClient) {
        toast.error('Your wallet is not ready. Reconnect and try again.');
        return false;
      }
      try {
        setPendingAction(String(functionName));
        setIsWriting(true);
        devLog('[BlackjackGame] writeContract start', { functionName, args, value });
        const hash = await writeBlackjackContract({
          publicClient,
          walletClient,
          contractAddress: contractAddress!,
          functionName,
          args: args as never,
          value
        });
        applyOptimisticAction(String(functionName), args);
        toast.message('Transaction submitted', {
          description: shortenTxHash(hash)
        });
        devLog('[BlackjackGame] writeContract submitted', { functionName, hash });
        void refetchCore();
        await waitForReceipt(hash);
        devLog('[BlackjackGame] writeContract confirmed', { functionName, hash });
        if (successMessage) {
          toast.success(successMessage);
        }
        await refetchAfterWrite(refreshMode);
        setOptimisticOverlay(null);
        return true;
      } catch (error) {
        setOptimisticOverlay(null);
        logTechnicalError(`[BlackjackGame] writeContract error (${String(functionName)})`, error, {
          functionName,
          args,
          value
        });
        const title = getActionErrorTitle(String(functionName));
        const friendly = friendlyRevertMessage(error);
        if (friendly) {
          toast.error(title, { description: friendly });
        } else {
          handleError(error, title);
        }
        return false;
      } finally {
        setPendingAction(null);
        setIsWriting(false);
      }
    },
    [
      applyOptimisticAction,
      contractAddress,
      handleError,
      publicClient,
      refetchAfterWrite,
      refetchCore,
      requireWallet,
      waitForReceipt,
      walletClient
    ]
  );

  // Public actions – guard against acting mid-showdown and surface UX feedback.
  const actions = useMemo(
    () => ({
      claimFreeChips: async () => {
        if (hasClaimed === undefined) {
          toast.info('Checking claim status — try again in a moment.');
          return false;
        }
        if (hasClaimed) {
          toast.info('You have already claimed your free chips.');
          return false;
        }
        return execute({ functionName: 'claimFreeChips', args: [] }, 'Free chips claimed', 'all');
      },
      buyChips: async (weiAmount: bigint) => {
        if (weiAmount <= 0n) {
          toast.error('Send a positive amount of ETH to buy chips.');
          return false;
        }
        if (!publicClient || !walletAddress || !contractAddress) {
          toast.error('Your wallet is not ready. Reconnect and try again.');
          return false;
        }
        try {
          const preflightError = await validateBuyChipsPreflight(
            publicClient,
            contractAddress,
            walletAddress,
            weiAmount,
            currentTableId as bigint | undefined
          );
          if (preflightError) {
            toast.error(preflightError);
            return false;
          }
        } catch (error) {
          logTechnicalError('[BlackjackGame] buyChips preflight failed', error);
        }
        return execute({ functionName: 'buyChips', args: [], value: weiAmount }, 'Chips purchased', 'all');
      },
      withdrawChips: async (chipAmount: bigint) => {
        if (chipAmount <= 0n) {
          toast.error('Enter a chip amount greater than zero.');
          return false;
        }
        if (!publicClient || !walletAddress || !contractAddress) {
          toast.error('Your wallet is not ready. Reconnect and try again.');
          return false;
        }
        try {
          const preflightError = await validateWithdrawChipsPreflight(
            publicClient,
            contractAddress,
            walletAddress,
            chipAmount,
            currentTableId as bigint | undefined,
            walletChipBalance
          );
          if (preflightError) {
            toast.error(preflightError);
            return false;
          }
        } catch (error) {
          logTechnicalError('[BlackjackGame] withdrawChips preflight failed', error);
        }
        return execute(
          { functionName: 'withdrawChips', args: [chipAmount] as const },
          `Withdrew ${chipAmount.toString()} chips`,
          'all'
        );
      },
      createTable: async (minBuyIn: bigint, maxBuyIn: bigint) => (
        execute({ functionName: 'createTable', args: [minBuyIn, maxBuyIn] as const }, 'Table created', 'all')
      ),
      joinTable: async (buyIn: bigint) => {
        if (buyIn <= 0n) {
          toast.error('Buy-in must be positive.');
          return false;
        }
        if (table) {
          if (buyIn < table.minBuyIn || buyIn > table.maxBuyIn) {
            toast.error(`Buy-in must be between ${table.minBuyIn} and ${table.maxBuyIn} chips.`);
            return false;
          }
        }
        if (walletChipBalance !== undefined && buyIn > walletChipBalance) {
          toast.error('Not enough chips in your wallet. Claim free chips or buy more first.');
          return false;
        }
        return execute({ functionName: 'joinTable', args: [tableId, buyIn] as const }, 'Joined table', 'all');
      },
      leaveTable: async () => (
        execute({ functionName: 'leaveTable', args: [tableId] as const }, 'Left the table', 'all')
      ),
      cashOut: async () => (
        execute({ functionName: 'cashOut', args: [tableId] as const }, 'Cashed out', 'all')
      ),
      topUpChips: async (amount: bigint) => {
        if (amount <= 0n) {
          toast.error('Enter an amount greater than zero.');
          return false;
        }
        return execute(
          { functionName: 'topUpTableChips', args: [tableId, amount] as const },
          'Chips moved to table',
          'all'
        );
      },
      placeBet: async (amount: bigint) => {
        if (awaitingNextHand) {
          toast.info('Review the last hand before betting again.');
          return false;
        }
        if (amount <= 0n) {
          toast.error('Bet amount must be positive.');
          return false;
        }
        return execute(
          { functionName: 'placeBet', args: [tableId, amount] as const },
          `Bet ${amount.toString()} chips placed`,
          'core'
        );
      },
      hit: async () => {
        if (awaitingNextHand) {
          toast.info('Review the last hand before acting.');
          return false;
        }
        if (!guardPlayerAction()) return false;
        return execute({ functionName: 'hit', args: [tableId] as const }, 'Card dealt', 'core');
      },
      stand: async () => {
        if (awaitingNextHand) {
          toast.info('Review the last hand before acting.');
          return false;
        }
        if (!guardPlayerAction()) return false;
        return execute({ functionName: 'stand', args: [tableId] as const }, 'Stood', 'core');
      },
      doubleDown: async () => {
        if (awaitingNextHand) {
          toast.info('Review the last hand before acting.');
          return false;
        }
        if (!guardPlayerAction()) return false;
        return execute({ functionName: 'doubleDown', args: [tableId] as const }, 'Double down executed', 'core');
      },
      acknowledgeShowdown: async () => {
        if (latestResultTimestamp === 0) return;
        setAcknowledgedResultTimestamp(latestResultTimestamp);
        setWinners(null);
      },
      retryPlayerDecrypt: () => retryPlayerDecrypt(),
      retryDealerDecrypt: () => retryDealerDecrypt(),
      resetDecryption: () => resetDecryption()
    }),
    [
      awaitingNextHand,
      contractAddress,
      currentTableId,
      execute,
      guardPlayerAction,
      hasActiveSeat,
      latestResultTimestamp,
      publicClient,
      resetDecryption,
      retryDealerDecrypt,
      retryPlayerDecrypt,
      table,
      tableId,
      walletAddress,
      walletChipBalance,
      hasClaimed
    ]
  );

  useWatchContractEvent({
    address: contractAddress,
    abi: blackjackAbi,
    eventName: 'OracleActionRequired',
    args: { tableId },
    enabled: eventsEnabled,
    onLogs: (logs) => {
      devLog('[BlackjackGame] OracleActionRequired event', { tableId, logs });
      scheduleCoreRefetch();
    }
  });

  useWatchContractEvent({
    address: contractAddress,
    abi: blackjackAbi,
    eventName: 'EncryptedCardDealt',
    args: { tableId },
    enabled: eventsEnabled,
    onLogs: (logs) => {
      devLog('[BlackjackGame] EncryptedCardDealt event', { tableId, logs });
      scheduleCoreRefetch();
    }
  });

  useWatchContractEvent({
    address: contractAddress,
    abi: blackjackAbi,
    eventName: 'PhaseChanged',
    args: { tableId },
    enabled: eventsEnabled,
    onLogs: (logs) => {
      devLog('[BlackjackGame] PhaseChanged event', { tableId, logs });
      scheduleCoreRefetch();
    }
  });

  useWatchContractEvent({
    address: contractAddress,
    abi: blackjackAbi,
    eventName: 'HandResultStored',
    args: { tableId },
    enabled: eventsEnabled,
    onLogs: (logs) => {
      devLog('[BlackjackGame] HandResultStored event', { tableId, logs });
      scheduleCoreRefetch();
      void refreshTableActivity();
    }
  });

  useWatchContractEvent({
    address: contractAddress,
    abi: blackjackAbi,
    eventName: 'WinnerDetermined',
    args: { tableId },
    enabled: eventsEnabled,
    onLogs: (logs) => {
      devLog('[BlackjackGame] WinnerDetermined event', { tableId, logs });
      const last = logs.pop();
      if (!last?.args) return;
      const payload: WinnerEventPayload = {
        tableId: last.args.tableId as bigint,
        winners: (last.args.winners || []) as `0x${string}`[],
        amounts: (last.args.amounts || []) as bigint[]
      };
      setWinners(payload);
      scheduleCoreRefetch();
    }
  });

  useWatchContractEvent({
    address: contractAddress,
    abi: blackjackAbi,
    eventName: 'PlayerAction',
    args: { tableId },
    enabled: eventsEnabled,
    onLogs: (logs) => {
      devLog('[BlackjackGame] PlayerAction event', { tableId, logs });
      scheduleCoreRefetch();
    }
  });

  useWatchContractEvent({
    address: contractAddress,
    abi: blackjackAbi,
    eventName: 'BetPlaced',
    args: { tableId },
    enabled: eventsEnabled,
    onLogs: (logs) => {
      devLog('[BlackjackGame] BetPlaced event', { tableId, logs });
      scheduleCoreRefetch();
    }
  });

  useWatchContractEvent({
    address: contractAddress,
    abi: blackjackAbi,
    eventName: 'TurnAutoAdvanced',
    args: { tableId },
    enabled: eventsEnabled,
    onLogs: (logs) => {
      devLog('[BlackjackGame] TurnAutoAdvanced event', { tableId, logs });
      for (const log of logs) {
        const timedOut = log.args?.playerTimedOut as `0x${string}` | undefined;
        const reason = (log.args?.reason as string | undefined) ?? 'timeout';
        if (!timedOut) continue;
        const short = `${timedOut.slice(0, 6)}…${timedOut.slice(-4)}`;
        const isSelf = lowerWalletAddress && timedOut.toLowerCase() === lowerWalletAddress;
        if (reason === 'timeout-stand' || reason === 'timeout') {
          toast.info(
            isSelf
              ? 'Your turn timed out — you were auto-stood.'
              : `${short} timed out and was auto-stood.`
          );
        } else {
          toast.info(
            isSelf
              ? 'Your turn was auto-advanced.'
              : `${short}'s turn was auto-advanced.`
          );
        }
      }
      scheduleCoreRefetch();
    }
  });

  return {
    contractAddress,
    tableId,
    hasTable,
    table,
    gameState,
    connectedPlayer,
    walletChips: walletChipBalance,
    withdrawableChips: withdrawableChips as bigint | undefined,
    hasClaimedFreeChips: typeof hasClaimed === 'boolean' ? hasClaimed : undefined,
    playerTableId: currentTableId as bigint | undefined,
    isSeated,
    isPlayerTurn: effectivePlayerTurn,
    oraclePending,
    oraclePendingForSelf,
    pendingOracleKind,
    pendingOraclePlayer,
    oracleConfirmingBust,
    tableActivity: displayTableActivity,
    refreshTableActivity,
    tableStuck,
    turnTimer,
    winners,
    isLoading: isFetchingTable || isWriting,
    showdownResult,
    lastHandSummary,
    awaitingNextHand,
    playerDecryptState,
    dealerDecryptState,
    dealerRevealTimestamp,
    dealerPublicHand,
    dealerHandForLastResult,
    refetchAll,
    actions,
    pendingAction,
    connectedDecryptedHand: connectedDecryptedHandState
  };
};
