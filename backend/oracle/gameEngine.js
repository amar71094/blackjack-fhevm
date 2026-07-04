/**
 * Off-chain blackjack engine for the CipherJack game oracle.
 * Card encoding: rank 2-14 (Ace=14), suit 0-3 (hearts,diamonds,clubs,spades).
 * Deck order: permutation of indices 0..51.
 */

const RANKS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
const SUITS = [0, 1, 2, 3];

const PendingKind = {
  None: 0,
  DealHand: 1,
  Hit: 2,
  Stand: 3,
  DoubleDown: 4,
  DealerPlay: 5,
  Settle: 6
};

const Outcome = {
  Lose: 0,
  Win: 1,
  Push: 2,
  Blackjack: 3
};

function indexToCard(index) {
  const suit = Math.floor(index / 13);
  const rank = RANKS[index % 13];
  return { rank, suit, index };
}

function cardToIndex(rank, suit) {
  const rankIdx = RANKS.indexOf(rank);
  if (rankIdx < 0 || suit < 0 || suit > 3) throw new Error(`Invalid card ${rank}/${suit}`);
  return suit * 13 + rankIdx;
}

function handTotal(ranks) {
  let total = 0;
  let aces = 0;
  for (const r of ranks) {
    if (r === 14) {
      total += 1;
      aces++;
    } else if (r > 10) total += 10;
    else total += r;
  }
  if (aces > 0 && total + 10 <= 21) total += 10;
  return total;
}

function isBlackjack(ranks) {
  return ranks.length === 2 && handTotal(ranks) === 21;
}

function isBusted(ranks) {
  return handTotal(ranks) > 21;
}

function fisherYatesShuffle(array, seed) {
  const arr = [...array];
  let s = BigInt(seed);
  for (let i = arr.length - 1; i > 0; i--) {
    s = (s * 1103515245n + 12345n) & 0x7fffffffn;
    const j = Number(s % BigInt(i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function buildDeckOrder(seed) {
  const indices = Array.from({ length: 52 }, (_, i) => i);
  return fisherYatesShuffle(indices, seed);
}

function deckCommitment(deckOrder) {
  const { ethers } = require('ethers');
  if (deckOrder.length !== 52) throw new Error('Deck must have 52 cards');
  return ethers.keccak256(Uint8Array.from(deckOrder));
}

function dealInitialHands(deckOrder, deckIndex, activePlayers) {
  const playerCards = {};
  let cursor = deckIndex;
  for (const addr of activePlayers) {
    const c1 = indexToCard(deckOrder[cursor++]);
    const c2 = indexToCard(deckOrder[cursor++]);
    playerCards[addr.toLowerCase()] = [c1, c2];
  }
  const d1 = indexToCard(deckOrder[cursor++]);
  const d2 = indexToCard(deckOrder[cursor++]);
  return {
    playerCards,
    dealerCards: [d1, d2],
    deckCursor: cursor
  };
}

function drawCard(deckOrder, cursor) {
  const card = indexToCard(deckOrder[cursor]);
  return { card, nextCursor: cursor + 1 };
}

function dealerShouldHit(ranks) {
  return handTotal(ranks) < 17;
}

function computePayout(bet, outcome) {
  if (outcome === Outcome.Blackjack) return (bet * 3n) / 2n;
  if (outcome === Outcome.Win) return bet * 2n;
  if (outcome === Outcome.Push) return bet;
  return 0n;
}

function resolveOutcome(playerRanks, dealerRanks) {
  const pTotal = handTotal(playerRanks);
  const dTotal = handTotal(dealerRanks);
  const pBJ = isBlackjack(playerRanks);
  const dBJ = isBlackjack(dealerRanks);

  if (isBusted(playerRanks)) return Outcome.Lose;
  if (pBJ && dBJ) return Outcome.Push;
  if (pBJ) return Outcome.Blackjack;
  if (dBJ) return Outcome.Lose;
  if (isBusted(dealerRanks)) return Outcome.Win;
  if (pTotal > dTotal) return Outcome.Win;
  if (pTotal === dTotal) return Outcome.Push;
  return Outcome.Lose;
}

class TableSession {
  constructor(tableId) {
    this.tableId = tableId;
    this.deckOrder = null;
    this.deckIndex = 0;
    this.playerHands = new Map();
    this.dealerHand = [];
    /** @type {{ type: 'hit', addr: string } | { type: 'dealer' }}[]} */
    this.actionLog = [];
    this.dealSeed = null;
    this.deckCommitment = null;
  }

  resetForDeal(seed) {
    this.deckOrder = buildDeckOrder(seed);
    this.deckIndex = 0;
    this.playerHands.clear();
    this.dealerHand = [];
    this.actionLog = [];
    return this.deckOrder;
  }

  recordDeal(activeAddrs) {
    const { playerCards, dealerCards, deckCursor } = dealInitialHands(
      this.deckOrder,
      this.deckIndex,
      activeAddrs
    );
    for (const [addr, cards] of Object.entries(playerCards)) {
      this.playerHands.set(addr, cards.map((c) => ({ ...c })));
    }
    this.dealerHand = dealerCards.map((c) => ({ ...c }));
    this.deckIndex = deckCursor;
    return { playerCards, dealerCards, deckCursor };
  }

  snapshot() {
    const playerHands = new Map();
    for (const [key, hand] of this.playerHands.entries()) {
      playerHands.set(key, hand.map((card) => ({ ...card })));
    }
    return {
      deckOrder: this.deckOrder ? [...this.deckOrder] : null,
      deckIndex: this.deckIndex,
      playerHands,
      dealerHand: this.dealerHand.map((card) => ({ ...card })),
      actionLog: this.actionLog.map((entry) => ({ ...entry })),
      dealSeed: this.dealSeed,
      deckCommitment: this.deckCommitment
    };
  }

  restore(snapshot) {
    this.deckOrder = snapshot.deckOrder;
    this.deckIndex = snapshot.deckIndex;
    this.playerHands = snapshot.playerHands;
    this.dealerHand = snapshot.dealerHand;
    this.actionLog = snapshot.actionLog ?? [];
    this.dealSeed = snapshot.dealSeed ?? null;
    this.deckCommitment = snapshot.deckCommitment ?? null;
  }

  /** Draw the next card without mutating session state (commit after on-chain tx succeeds). */
  previewHit(addr) {
    const key = addr.toLowerCase();
    const hand = this.playerHands.get(key);
    if (!hand) throw new Error(`No hand for ${addr}`);
    const { card, nextCursor } = drawCard(this.deckOrder, this.deckIndex);
    const ranks = hand.map((c) => c.rank).concat(card.rank);
    return { card, busted: isBusted(ranks), nextCursor };
  }

  commitHit(addr, card, nextCursor) {
    const key = addr.toLowerCase();
    const hand = this.playerHands.get(key);
    if (!hand) throw new Error(`No hand for ${addr}`);
    hand.push({ ...card });
    this.deckIndex = nextCursor;
    this.actionLog.push({ type: 'hit', addr: key });
    return { card, busted: isBusted(hand.map((c) => c.rank)) };
  }

  hitPlayer(addr) {
    const preview = this.previewHit(addr);
    return this.commitHit(addr, preview.card, preview.nextCursor);
  }

  /** Dealer draw preview without mutating session. */
  previewDealerDraw() {
    const before = this.dealerHand.length;
    let cursor = this.deckIndex;
    const ranks = this.getDealerRanks();
    const newCards = [];
    while (dealerShouldHit(ranks)) {
      const { card, nextCursor } = drawCard(this.deckOrder, cursor);
      newCards.push(card);
      ranks.push(card.rank);
      cursor = nextCursor;
    }
    return { before, newCards, finalCount: before + newCards.length, nextCursor: cursor };
  }

  commitDealerDraw(newCards, nextCursor) {
    for (const card of newCards) {
      this.dealerHand.push({ ...card });
    }
    this.deckIndex = nextCursor;
    if (newCards.length > 0) {
      this.actionLog.push({ type: 'dealer' });
    }
    return this.dealerHand;
  }

  getPlayerRanks(addr) {
    const hand = this.playerHands.get(addr.toLowerCase());
    if (!hand) return [];
    return hand.map((c) => c.rank);
  }

  getDealerRanks() {
    return this.dealerHand.map((c) => c.rank);
  }

  getDealerSuits() {
    return this.dealerHand.map((c) => c.suit);
  }

  matchesPlay(play) {
    if (!this.deckOrder) return false;
    if (this.dealerHand.length !== play.dealer.cardCount) return false;
    for (const player of play.players) {
      if (player.bet <= 0n) continue;
      const hand = this.playerHands.get(player.addr.toLowerCase());
      if (!hand || hand.length !== player.cardCount) return false;
    }
    return true;
  }

  tryRecoverFromDealSeed(activeAddrs, play) {
    if (!this.dealSeed) return false;
    const savedLog = this.actionLog.map((entry) => ({ ...entry }));
    this.resetForDeal(BigInt(this.dealSeed));
    this.actionLog = savedLog;
    if (savedLog.length === 0) {
      this.recordDeal(activeAddrs);
      return this.matchesPlay(play);
    }
    return this.tryRebuildFromActionLog(activeAddrs, play);
  }

  catchUpDealerCardCount(targetCount) {
    if (!this.deckOrder || targetCount <= this.dealerHand.length) return true;
    while (this.dealerHand.length < targetCount) {
      const { card, nextCursor } = drawCard(this.deckOrder, this.deckIndex);
      this.dealerHand.push(card);
      this.deckIndex = nextCursor;
    }
    return this.dealerHand.length === targetCount;
  }

  /** Replay deck draws until session card counts match on-chain (after oracle tx lag). */
  syncPlayerCountsFromChain(play) {
    if (!this.deckOrder) return false;
    let changed = false;
    for (const player of play.players) {
      if (player.bet <= 0n) continue;
      const key = player.addr.toLowerCase();
      let hand = this.playerHands.get(key);
      if (!hand) continue;
      while (hand.length < player.cardCount) {
        const { card, nextCursor } = drawCard(this.deckOrder, this.deckIndex);
        hand.push(card);
        this.deckIndex = nextCursor;
        this.actionLog.push({ type: 'hit', addr: key });
        changed = true;
      }
    }
    return changed;
  }

  syncFromChainPlay(play) {
    if (!this.deckOrder) return false;
    const playersChanged = this.syncPlayerCountsFromChain(play);
    const dealerChanged =
      this.dealerHand.length < play.dealer.cardCount &&
      this.catchUpDealerCardCount(play.dealer.cardCount);
    return playersChanged || dealerChanged;
  }

  tryRebuildFromActionLog(activeAddrs, play) {
    if (!this.deckOrder || this.actionLog.length === 0) return false;

    this.playerHands.clear();
    this.dealerHand = [];
    let cursor = 0;

    for (const addr of activeAddrs) {
      const key = addr.toLowerCase();
      this.playerHands.set(key, [
        indexToCard(this.deckOrder[cursor++]),
        indexToCard(this.deckOrder[cursor++])
      ]);
    }
    this.dealerHand = [
      indexToCard(this.deckOrder[cursor++]),
      indexToCard(this.deckOrder[cursor++])
    ];

    for (const entry of this.actionLog) {
      if (entry.type === 'hit') {
        const hand = this.playerHands.get(entry.addr);
        if (!hand) return false;
        hand.push(indexToCard(this.deckOrder[cursor++]));
      } else if (entry.type === 'dealer') {
        while (dealerShouldHit(this.getDealerRanks())) {
          this.dealerHand.push(indexToCard(this.deckOrder[cursor++]));
        }
      }
    }

    this.deckIndex = cursor;
    return this.matchesPlay(play);
  }

  playDealerToCompletion() {
    while (dealerShouldHit(this.getDealerRanks())) {
      const { card, nextCursor } = drawCard(this.deckOrder, this.deckIndex);
      this.dealerHand.push(card);
      this.deckIndex = nextCursor;
    }
    return this.dealerHand;
  }

  buildSettlePayload(activePlayers) {
    const dealerRanks = this.getDealerRanks();
    const dealerTotal = handTotal(dealerRanks);
    const dealerBusted = isBusted(dealerRanks);

    const players = [];
    const totals = [];
    const outcomes = [];
    const payouts = [];

    for (const p of activePlayers) {
      const addr = p.addr ?? p.address;
      const ranks = this.getPlayerRanks(addr);
      const outcome = resolveOutcome(ranks, dealerRanks);
      const bet = BigInt(p.bet ?? 0);
      players.push(addr);
      totals.push(handTotal(ranks));
      outcomes.push(outcome);
      payouts.push(computePayout(bet, outcome));
    }

    return { players, totals, outcomes, payouts, dealerTotal, dealerBusted };
  }

  buildDealCalldata(activePlayers, seed) {
    const deckOrder = this.resetForDeal(seed);
    const { playerCards, dealerCards, deckCursor } = this.recordDeal(
      activePlayers.map((p) => p.addr ?? p.address)
    );

    const playerAddrs = [];
    const playerRanks = [];
    const playerSuits = [];
    for (const p of activePlayers) {
      const addr = (p.addr ?? p.address).toLowerCase();
      const cards = playerCards[addr];
      playerAddrs.push(p.addr ?? p.address);
      playerRanks.push(cards[0].rank, cards[1].rank);
      playerSuits.push(cards[0].suit, cards[1].suit);
    }

    const dealerRanks = dealerCards.map((c) => c.rank);
    const dealerSuits = dealerCards.map((c) => c.suit);

    return {
      deckCommitment: deckCommitment(deckOrder),
      deckOrder,
      deckCursor,
      playerRanks,
      playerSuits,
      playerAddrs,
      dealerRanks,
      dealerSuits,
      allRanks: [...playerRanks, ...dealerRanks],
      allSuits: [...playerSuits, ...dealerSuits]
    };
  }
}

module.exports = {
  PendingKind,
  Outcome,
  TableSession,
  buildDeckOrder,
  deckCommitment,
  indexToCard,
  handTotal,
  isBusted,
  isBlackjack,
  cardToIndex,
  dealerShouldHit,
  resolveOutcome,
  computePayout
};