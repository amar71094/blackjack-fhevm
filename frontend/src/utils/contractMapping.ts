import {
  GamePhase,
  TableStatus,
  ContractTable,
  ContractPlayPlayer,
  ContractHandResult,
  ContractPlayerResult,
  ContractOutcome
} from '@/types/blackjackContract';
import { Card, Dealer, GameState, Player, PlayerOutcome } from '@/types/blackjack';

const suitMap = ['hearts', 'diamonds', 'clubs', 'spades'] as const;
const rankMap = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'] as const;

export const toRankSymbol = (rank: number) => {
  if (rank < 2 || rank > 14) return '??';
  return rankMap[rank - 2];
};

export const toSuitSymbol = (suit: number) => suitMap[suit] ?? 'hearts';

const shorten = (address: string): string => {
  if (!address || address.length < 10) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
};

const toSafeLower = (value?: string | null) => (typeof value === 'string' ? value.toLowerCase() : undefined);

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;
type UnknownRecord = Record<string, unknown> | undefined;

const getNumber = (value: unknown): number => Number(value ?? 0);
const getBigInt = (value: unknown): bigint => (typeof value === 'bigint' ? value : BigInt(value ?? 0));
const getBoolean = (value: unknown): boolean => Boolean(value);
const getArray = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);
const getAddress = (value: unknown): `0x${string}` =>
  typeof value === 'string' ? (value as `0x${string}`) : ZERO_ADDRESS;

const emptyHandResult = (): ContractHandResult => ({
  dealerTotal: 0n,
  dealerBusted: false,
  results: [],
  pot: 0n,
  timestamp: 0n
});

export const normalizePlayPlayer = (player: UnknownRecord): ContractPlayPlayer => ({
  addr: getAddress(player?.['addr']),
  chips: getBigInt(player?.['chips']),
  bet: getBigInt(player?.['bet']),
  cardCount: getNumber(player?.['cardCount']),
  isActive: getBoolean(player?.['isActive']),
  hasActed: getBoolean(player?.['hasActed']),
  busted: getBoolean(player?.['busted'])
});

export const normalizeHandResult = (hand: UnknownRecord | undefined): ContractHandResult => {
  if (!hand) return emptyHandResult();
  return {
    dealerTotal: getBigInt(hand['dealerTotal']),
    dealerBusted: getBoolean(hand['dealerBusted']),
    results: getArray<UnknownRecord>(hand['results']).map((result) => ({
      addr: getAddress(result?.['addr']),
      bet: getBigInt(result?.['bet']),
      total: getBigInt(result?.['total']),
      outcome: getNumber(result?.['outcome']),
      payout: getBigInt(result?.['payout'])
    })),
    pot: getBigInt(hand['pot']),
    timestamp: getBigInt(hand['timestamp'])
  };
};

export const normalizePlayTable = (table: UnknownRecord): ContractTable => ({
  id: getBigInt(table?.['id']),
  status: getNumber(table?.['status']) as TableStatus,
  minBuyIn: getBigInt(table?.['minBuyIn']),
  maxBuyIn: getBigInt(table?.['maxBuyIn']),
  deckCommitment: getAddress(table?.['deckCommitment']),
  deckIndex: getNumber(table?.['deckIndex']),
  phase: getNumber(table?.['phase']) as GamePhase,
  players: getArray<UnknownRecord>(table?.['players']).map(normalizePlayPlayer),
  dealer: {
    cardCount: getNumber((table?.['dealer'] as UnknownRecord)?.['cardCount']),
    hasFinished: getBoolean((table?.['dealer'] as UnknownRecord)?.['hasFinished'])
  },
  lastActivityTimestamp: getBigInt(table?.['lastActivityTimestamp']),
  pendingKind: getNumber(table?.['pendingKind']),
  pendingPlayer: getAddress(table?.['pendingPlayer']),
  lastHandResult: emptyHandResult()
});

export const mergeTableWithHandResult = (
  table: ContractTable,
  hand: ContractHandResult
): ContractTable => ({
  ...table,
  lastHandResult: hand
});

/** @deprecated Use normalizePlayTable — kept as alias for gradual migration. */
export const normalizeTable = normalizePlayTable;

export const toUiCard = (rank: number, suit: number, index: number): Card => ({
  suit: toSuitSymbol(suit),
  rank: toRankSymbol(rank),
  id: `${rank}-${suit}-${index}`
});

export const toHiddenCard = (index: number, prefix: string): Card => ({
  suit: '??',
  rank: '??',
  id: `${prefix}-hidden-${index}`
});

export const hasRevealedCards = (cards: Card[] | undefined): cards is Card[] =>
  Boolean(cards?.some((card) => card.rank !== '??'));

export const calculateHandValue = (cards: Card[]) => {
  let total = 0;
  let aces = 0;
  for (const card of cards) {
    if (card.rank === '??') {
      continue;
    }
    if (card.rank === 'A') {
      total += 11;
      aces++;
    } else if (['K', 'Q', 'J', '10'].includes(card.rank)) {
      total += 10;
    } else {
      total += Number(card.rank);
    }
  }
  while (total > 21 && aces > 0) {
    total -= 10;
    aces--;
  }
  return total;
};

/** Detect bust from on-chain flag, revealed total, and/or inactive+acted after oracle bust. */
export const resolvePlayerBust = (
  player: Pick<Player, 'bust' | 'isActive' | 'hasActed' | 'hand' | 'bet'> & { chainBusted?: boolean },
  revealedTotal?: number | null
): boolean => {
  if (player.chainBusted) return true;
  if (player.bust) return true;
  if (revealedTotal !== null && revealedTotal !== undefined && revealedTotal > 21) {
    return true;
  }
  return !player.isActive && player.hasActed && player.hand.length > 0 && player.bet > 0;
};

const toUiPlayer = (player: ContractPlayPlayer, index: number): Player => {
  const hand = Array.from({ length: player.cardCount }, (_, cardIndex) =>
    toHiddenCard(cardIndex, `${player.addr}-${index}`)
  );
  const stand = player.isActive && player.hasActed && hand.length > 0 && !player.busted;
  const bust =
    player.busted ||
    (!player.isActive && player.hasActed && hand.length > 0 && Number(player.bet) > 0);

  return {
    id: `${player.addr}-${index}`,
    address: player.addr,
    name: shorten(player.addr),
    hand,
    displayHand: hand,
    displayTotal: null,
    cardsRevealed: false,
    bet: Number(player.bet),
    chips: Number(player.chips),
    bust,
    stand,
    blackjack: false,
    position: index,
    isActive: player.isActive,
    hasActed: player.hasActed,
    result: null
  };
};

const toUiDealer = (dealer: ContractTable['dealer']): Dealer => {
  const hand = Array.from({ length: dealer.cardCount }, (_, cardIndex) =>
    toHiddenCard(cardIndex, 'dealer')
  );
  const visible = dealer.cardCount > 0 ? [toHiddenCard(0, 'dealer-up'), ...hand.slice(1)] : hand;

  return {
    hand,
    displayHand: visible,
    displayTotal: null,
    cardsRevealed: false,
    blackjack: false,
    bust: false
  };
};

const phaseMap: Record<GamePhase, GameState['phase']> = {
  [GamePhase.WaitingForPlayers]: 'betting',
  [GamePhase.Dealing]: 'dealing',
  [GamePhase.PlayerTurns]: 'player-turn',
  [GamePhase.DealerTurn]: 'dealer-turn',
  [GamePhase.Showdown]: 'showdown',
  [GamePhase.Completed]: 'waiting'
};

const statusMap: Record<TableStatus, GameState['status']> = {
  [TableStatus.Waiting]: 'waiting',
  [TableStatus.Active]: 'active',
  [TableStatus.Closed]: 'closed'
};

export const toUiGameState = (table: ContractTable): GameState => {
  const players = table.players.map(toUiPlayer);
  const dealer = toUiDealer(table.dealer);
  const phase = phaseMap[table.phase] ?? 'waiting';
  const status = statusMap[table.status] ?? 'waiting';

  const activePlayerIndex = players.findIndex(
    (player) => player.isActive && !player.hasActed && !player.bust
  );
  const roundActive = ['dealing', 'player-turn', 'dealer-turn', 'showdown'].includes(phase);
  const pot = players.reduce((total, player) => total + player.bet, 0);

  return {
    tableId: Number(table.id),
    status,
    minBuyIn: Number(table.minBuyIn),
    maxBuyIn: Number(table.maxBuyIn),
    phase,
    players,
    dealer,
    deck: [],
    activePlayerIndex,
    roundActive,
    winners: [],
    pot,
    lastActivityTimestamp: Number(table.lastActivityTimestamp),
    contractPhase: table.phase
  };
};

const outcomeMap: Record<number, PlayerOutcome> = {
  [ContractOutcome.Lose]: 'lose',
  [ContractOutcome.Win]: 'win',
  [ContractOutcome.Push]: 'push',
  [ContractOutcome.Blackjack]: 'blackjack'
};

const mapOutcome = (value: number, bust: boolean): PlayerOutcome => {
  if (bust) return 'bust';
  return outcomeMap[value] ?? 'lose';
};

export const toShowdownSummaryFromHand = (
  tableId: number,
  hand: ContractHandResult,
  playersLookup: Map<string, Player>,
  dealerCards?: Card[]
): ShowdownSummary | null => {
  if (!hand || Number(hand.timestamp) === 0) return null;

  const chainDealerValue = Number(hand.dealerTotal ?? 0n);
  const dealerCardsRevealed = hasRevealedCards(dealerCards);
  const computedDealerValue = dealerCardsRevealed ? calculateHandValue(dealerCards) : null;
  const dealerValue =
    chainDealerValue > 0 ? chainDealerValue : computedDealerValue ?? chainDealerValue;
  const dealerBust =
    Boolean(hand.dealerBusted) || (computedDealerValue !== null && computedDealerValue > 21);
  const placeholderCount = dealerCards?.length ?? 2;
  const dealerHand =
    dealerCards ??
    Array.from({ length: placeholderCount }, (_, index) => toHiddenCard(index, 'dealer-result'));

  const dealer: Dealer & { handValue: number; bust: boolean } = {
    hand: dealerHand,
    displayHand: dealerHand,
    displayTotal: dealerCardsRevealed ? dealerValue : chainDealerValue,
    cardsRevealed: dealerCardsRevealed,
    blackjack: dealerCardsRevealed && dealerHand.length === 2 && dealerValue === 21,
    bust: dealerBust,
    handValue: dealerValue
  };

  const summaries: ShowdownPlayerSummary[] = hand.results.map((result) => {
    const value = Number(result.total ?? 0n);
    const bust = value > 21;
    const lookupKey = toSafeLower(result.addr);
    const basePlayer = (lookupKey && playersLookup.get(lookupKey)) ?? {
      id: `${result.addr}-result`,
      address: result.addr,
      name: shorten(result.addr),
      hand: [],
      displayHand: [],
      displayTotal: value,
      cardsRevealed: false,
      bet: Number(result.bet),
      chips: 0,
      bust,
      stand: !bust,
      blackjack: value === 21,
      position: 0,
      isActive: false,
      hasActed: true,
      result: null as PlayerOutcome
    } satisfies Player;

    const player: Player = {
      ...basePlayer,
      displayTotal: value,
      cardsRevealed: basePlayer.cardsRevealed,
      bet: Number(result.bet),
      bust,
      blackjack: value === 21 && !bust,
      result: mapOutcome(Number(result.outcome), bust)
    };

    const outcome = mapOutcome(Number(result.outcome), bust);

    return {
      player,
      outcome,
      handValue: value,
      blackjack: player.blackjack ?? false,
      bust
    } satisfies ShowdownPlayerSummary;
  });

  const winners = summaries.filter((summary) =>
    summary.outcome === 'blackjack' || summary.outcome === 'win'
  );
  const dealerWins = winners.length === 0;

  return {
    tableId,
    handTimestamp: Number(hand.timestamp ?? 0n),
    dealer,
    pot: Number(hand.pot ?? 0n),
    players: summaries,
    winners,
    dealerWins
  } satisfies ShowdownSummary;
};

export const formatChips = (value: bigint | number | undefined) => {
  if (value === undefined) return '—';
  const num = typeof value === 'bigint' ? Number(value) : value;
  if (Number.isNaN(num)) return '—';
  return num.toLocaleString();
};

export interface ShowdownPlayerSummary {
  player: Player;
  outcome: PlayerOutcome;
  handValue: number;
  blackjack: boolean;
  bust: boolean;
}

export interface ShowdownSummary {
  tableId: number;
  handTimestamp: number;
  dealer: Dealer & { handValue: number; bust: boolean };
  pot: number;
  players: ShowdownPlayerSummary[];
  winners: ShowdownPlayerSummary[];
  dealerWins: boolean;
}

export const summarizeShowdown = (state: GameState): ShowdownSummary => {
  const dealerValue = calculateHandValue(state.dealer.hand);
  const dealerBust = dealerValue > 21;
  const dealerBlackjack = state.dealer.blackjack || (state.dealer.hand.length === 2 && dealerValue === 21);

  const activePlayers = state.players.filter((player) => player.hand.length > 0 || player.bet > 0);

  const playerSummaries = activePlayers.map((player) => {
    const value = calculateHandValue(player.hand);
    const blackjack = player.blackjack || (player.hand.length === 2 && value === 21);
    const bust = player.bust || value > 21;

    let outcome: PlayerOutcome;

    if (bust) outcome = 'bust';
    else if (blackjack && !dealerBlackjack) outcome = 'blackjack';
    else if (dealerBlackjack && blackjack) outcome = 'push';
    else if (dealerBlackjack) outcome = 'lose';
    else if (dealerBust || value > dealerValue) outcome = 'win';
    else if (value === dealerValue) outcome = 'push';
    else outcome = 'lose';

    const summaryPlayer: Player = {
      ...player,
      hand: player.hand,
      displayHand: player.hand,
      displayTotal: value,
      cardsRevealed: true,
      bust,
      blackjack,
      result: outcome
    };

    return {
      player: summaryPlayer,
      outcome,
      handValue: value,
      blackjack,
      bust
    } satisfies ShowdownPlayerSummary;
  });

  const winners = playerSummaries.filter((summary) => summary.outcome === 'blackjack' || summary.outcome === 'win');
  const dealerWins = winners.length === 0;

  return {
    tableId: state.tableId,
    handTimestamp: state.lastActivityTimestamp,
    dealer: {
      ...state.dealer,
      hand: state.dealer.hand,
      displayHand: state.dealer.hand,
      displayTotal: dealerValue,
      cardsRevealed: true,
      blackjack: dealerBlackjack,
      bust: dealerBust,
      handValue: dealerValue
    },
    pot: state.pot,
    players: playerSummaries,
    winners,
    dealerWins
  } satisfies ShowdownSummary;
};