export enum TableStatus {
  Waiting,
  Active,
  Closed
}

export enum GamePhase {
  WaitingForPlayers,
  Dealing,
  PlayerTurns,
  DealerTurn,
  Showdown,
  Completed
}

export enum PendingKind {
  None,
  DealHand,
  Hit,
  Stand,
  DoubleDown,
  DealerPlay,
  Settle
}

export enum ContractOutcome {
  Lose,
  Win,
  Push,
  Blackjack
}

export interface ContractPlayPlayer {
  addr: `0x${string}`;
  chips: bigint;
  bet: bigint;
  cardCount: number;
  isActive: boolean;
  hasActed: boolean;
  busted: boolean;
}

export interface ContractPlayDealer {
  cardCount: number;
  hasFinished: boolean;
}

export interface ContractPlayerResult {
  addr: `0x${string}`;
  bet: bigint;
  total: bigint;
  outcome: ContractOutcome | number;
  payout: bigint;
}

export interface ContractHandResult {
  dealerTotal: bigint;
  dealerBusted: boolean;
  results: ContractPlayerResult[];
  pot: bigint;
  timestamp: bigint;
}

/** Privacy-safe live table state (no card values on-chain). */
export interface ContractTable {
  id: bigint;
  status: TableStatus;
  minBuyIn: bigint;
  maxBuyIn: bigint;
  deckCommitment: `0x${string}`;
  deckIndex: number;
  phase: GamePhase;
  players: ContractPlayPlayer[];
  dealer: ContractPlayDealer;
  lastActivityTimestamp: bigint;
  pendingKind: PendingKind | number;
  pendingPlayer: `0x${string}`;
  lastHandResult: ContractHandResult;
}

export interface WinnerEventPayload {
  tableId: bigint;
  winners: `0x${string}`[];
  amounts: bigint[];
}