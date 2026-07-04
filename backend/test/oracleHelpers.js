const hre = require('hardhat');
const { ethers } = require('hardhat');
const { PendingKind, TableSession } = require('../oracle/gameEngine');
const { encryptCardPairs } = require('../oracle/fheEncrypt');

const GamePhase = {
  WaitingForPlayers: 0,
  Dealing: 1,
  PlayerTurns: 2,
  DealerTurn: 3,
  Showdown: 4,
  Completed: 5
};

const sessions = new Map();

function getSession(tableId) {
  const key = String(tableId);
  if (!sessions.has(key)) sessions.set(key, new TableSession(tableId));
  return sessions.get(key);
}

function clearSessions() {
  sessions.clear();
}

function parsePlayTable(raw) {
  return {
    phase: Number(raw.phase),
    pendingKind: Number(raw.pendingKind),
    pendingPlayer: raw.pendingPlayer,
    players: raw.players.map((p) => ({
      addr: p.addr,
      bet: p.bet,
      cardCount: Number(p.cardCount),
      isActive: p.isActive,
      hasActed: p.hasActed,
      busted: Boolean(p.busted)
    })),
    dealer: {
      cardCount: Number(raw.dealer.cardCount),
      hasFinished: raw.dealer.hasFinished
    },
    deckIndex: Number(raw.deckIndex)
  };
}

async function encryptCards(blackjack, oracle, ranks, suits) {
  const contractAddress = await blackjack.getAddress();
  return encryptCardPairs(hre.fhevm, contractAddress, oracle.address, ranks, suits);
}

async function oracleFulfillPending(blackjack, oracle, tableId) {
  const raw = await blackjack.getTablePlayState(tableId);
  const play = parsePlayTable(raw);
  const session = getSession(tableId);
  const kind = play.pendingKind;
  const contractAddress = await blackjack.getAddress();

  if (kind === PendingKind.DealHand) {
    const active = play.players.filter((p) => p.bet > 0n && p.isActive);
    const seed = BigInt(ethers.keccak256(ethers.toUtf8Bytes(`test-${tableId}-${Date.now()}`)));
    const calldata = session.buildDealCalldata(active, seed);
    const enc = await encryptCardPairs(
      hre.fhevm,
      contractAddress,
      oracle.address,
      calldata.allRanks,
      calldata.allSuits
    );
    await blackjack.connect(oracle).oracleDealHand(
      tableId,
      calldata.deckCommitment,
      calldata.deckCursor,
      calldata.playerAddrs,
      enc.rankHandles,
      enc.suitHandles,
      enc.inputProof
    );
    return session;
  }

  if (kind === PendingKind.Hit || kind === PendingKind.DoubleDown) {
    const player = play.pendingPlayer;
    const { card, busted } = session.hitPlayer(player);
    const enc = await encryptCardPairs(
      hre.fhevm,
      contractAddress,
      oracle.address,
      [card.rank],
      [card.suit]
    );
    await blackjack.connect(oracle).oracleFulfillPending(
      tableId,
      enc.rankHandles,
      enc.suitHandles,
      enc.inputProof,
      [busted],
      [kind === PendingKind.DoubleDown || busted],
      play.dealer.cardCount,
      false
    );
    return session;
  }

  if (kind === PendingKind.Stand) {
    await blackjack.connect(oracle).oracleFulfillPending(
      tableId, [], [], '0x', [], [], play.dealer.cardCount, false
    );
    return session;
  }

  if (kind === PendingKind.DealerPlay) {
    const before = play.dealer.cardCount;
    session.playDealerToCompletion();
    const allRanks = session.getDealerRanks();
    const allSuits = session.getDealerSuits();
    const newRanks = allRanks.slice(before);
    const newSuits = allSuits.slice(before);
    const enc = await encryptCardPairs(
      hre.fhevm,
      contractAddress,
      oracle.address,
      newRanks,
      newSuits
    );
    await blackjack.connect(oracle).oracleFulfillPending(
      tableId,
      enc.rankHandles,
      enc.suitHandles,
      enc.inputProof,
      [],
      [],
      allRanks.length,
      true
    );
    return session;
  }

  if (kind === PendingKind.Settle) {
    const active = play.players.filter((p) => p.bet > 0n);
    const payload = session.buildSettlePayload(active);
    await blackjack.connect(oracle).oracleSettleWithOutcomes(
      tableId,
      payload.players,
      payload.totals,
      payload.outcomes,
      payload.payouts,
      payload.dealerTotal,
      payload.dealerBusted
    );
    sessions.delete(String(tableId));
    return session;
  }

  return session;
}

async function playHandToCompletion(blackjack, oracle, tableId, playerSigners) {
  for (let round = 0; round < 48; round++) {
    const raw = await blackjack.getTablePlayState(tableId);
    const play = parsePlayTable(raw);

    if (play.phase === GamePhase.WaitingForPlayers && play.pendingKind === PendingKind.None) {
      return play;
    }

    if (play.pendingKind !== PendingKind.None) {
      await oracleFulfillPending(blackjack, oracle, tableId);
      continue;
    }

    if (play.phase === GamePhase.PlayerTurns) {
      for (const signer of playerSigners) {
        const isTurn = await blackjack.isPlayerTurn(tableId, signer.address);
        if (isTurn) {
          await blackjack.connect(signer).stand(tableId);
        }
      }
      continue;
    }
  }
  throw new Error('Hand did not complete within iteration budget');
}

module.exports = {
  GamePhase,
  PendingKind,
  parsePlayTable,
  oracleFulfillPending,
  playHandToCompletion,
  clearSessions,
  encryptCards,
  getSession,
  TableSession
};