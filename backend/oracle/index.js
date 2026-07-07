#!/usr/bin/env node
/**
 * CipherJack game oracle — polls for pending actions and fulfills them.
 * Uses state polling (not eth filters) for compatibility with public Sepolia RPCs.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const crypto = require('crypto');
const path = require('path');
const { ethers } = require('ethers');
const {
  PendingKind,
  TableSession,
  handTotal,
  deckCommitment,
  isBusted,
  resolveOutcome
} = require('./gameEngine');
const { acquireProcessLock, releaseProcessLock } = require('./atomicStore');
const { encryptForRelayer, getRelayerInstance } = require('./fheEncrypt');

const PendingKindName = Object.fromEntries(
  Object.entries(PendingKind).map(([k, v]) => [v, k])
);

const { createFallbackProvider } = require('./rpcProvider');
const rpcPool = createFallbackProvider();
const ALLOW_DEPLOYER_FALLBACK = process.env.ALLOW_DEPLOYER_ORACLE_KEY === 'true';
const PRIVATE_KEY =
  process.env.ORACLE_PRIVATE_KEY ||
  (ALLOW_DEPLOYER_FALLBACK ? process.env.SEPOLIA_DEPLOYER_KEY : undefined);
const ORACLE_LOCK_PATH = path.join(__dirname, '.oracle.lock');
const CONTRACT_ADDRESS = process.env.BLACKJACK_CONTRACT_ADDRESS;
const POLL_INTERVAL_MS = Number(process.env.ORACLE_POLL_INTERVAL_MS ?? 8_000);
const ERROR_BACKOFF_MS = Number(process.env.ORACLE_ERROR_BACKOFF_MS ?? 15_000);
const GAS_BUMP_NUM = 150n;
const GAS_BUMP_DEN = 100n;

const { loadSessions, saveSessions } = require('./sessionStore');
const { rememberDealSeed, lookupDealSeed } = require('./commitmentStore');
const { recordHandHistoryFromContract } = require('./handHistoryRecord');
const { startActivityServer } = require('./activityServer');
const sessions = loadSessions();
const tableWork = new Map();
const tableBackoffUntil = new Map();
let oracleTxChain = Promise.resolve();
let cachedFeeData = null;
let cachedFeeAt = 0;
const FEE_CACHE_MS = 3_000;

function messageFromError(err) {
  if (!err) return '';
  if (typeof err === 'string') return err;
  if (err.shortMessage) return err.shortMessage;
  if (err.reason) return err.reason;
  if (err.message) return err.message;
  if (Array.isArray(err.errors) && err.errors.length > 0) {
    return messageFromError(err.errors[0]);
  }
  return String(err);
}

function isBenignOracleError(err) {
  const msg = messageFromError(err).toLowerCase();
  return (
    msg.includes('nothing pending') ||
    msg.includes('not deal pending') ||
    msg.includes('not settle pending') ||
    msg.includes('not hit pending') ||
    msg.includes('not stand pending') ||
    msg.includes('invalid pending kind')
  );
}

function isReplacementFeeError(err) {
  const msg = messageFromError(err).toLowerCase();
  return (
    msg.includes('replacement fee too low') ||
    msg.includes('nonce too low') ||
    msg.includes('nonce has already been used')
  );
}

function isNonceAlreadyUsedError(err) {
  return messageFromError(err).toLowerCase().includes('nonce has already been used');
}

function pendingFingerprint(play) {
  const playerCards = play.players
    .map((p) => `${p.addr.toLowerCase()}:${p.cardCount}`)
    .join(',');
  return `${play.pendingKind}:${play.pendingPlayer.toLowerCase()}:${play.deckIndex}:${play.dealer.cardCount}:${playerCards}`;
}

async function readPendingPlay(contract, tableId) {
  const raw = await contract.getTablePlayState(tableId);
  return parsePlayTable(raw);
}

async function assertPendingKind(contract, tableId, expectedKind) {
  const play = await readPendingPlay(contract, tableId);
  if (play.pendingKind !== expectedKind) {
    const err = new Error('Nothing pending');
    err.code = 'ORACLE_STALE_PENDING';
    throw err;
  }
  return play;
}

async function getCachedFeeData(provider) {
  const now = Date.now();
  if (cachedFeeData && now - cachedFeeAt < FEE_CACHE_MS) {
    return cachedFeeData;
  }
  cachedFeeData = await provider.getFeeData();
  cachedFeeAt = now;
  return cachedFeeData;
}

async function sendOracleTx(signer, txRequest, feeMultiplierNum = GAS_BUMP_NUM) {
  const provider = signer.provider;
  const fee = await getCachedFeeData(provider);
  const overrides = {};
  if (fee.maxFeePerGas) {
    overrides.maxFeePerGas = (fee.maxFeePerGas * feeMultiplierNum) / GAS_BUMP_DEN;
  }
  if (fee.maxPriorityFeePerGas) {
    overrides.maxPriorityFeePerGas = (fee.maxPriorityFeePerGas * feeMultiplierNum) / GAS_BUMP_DEN;
  } else if (fee.gasPrice) {
    overrides.gasPrice = (fee.gasPrice * feeMultiplierNum) / GAS_BUMP_DEN;
  }
  return signer.sendTransaction({ ...txRequest, ...overrides });
}

async function sendOracleTxSerialized(signer, txRequest) {
  const run = async () => {
    try {
      return await sendOracleTx(signer, txRequest);
    } catch (err) {
      if (isReplacementFeeError(err) && !isNonceAlreadyUsedError(err)) {
        return sendOracleTx(signer, txRequest, 200n);
      }
      throw err;
    }
  };
  const next = oracleTxChain.then(run, run);
  oracleTxChain = next.catch(() => {});
  return next;
}

function getSession(tableId) {
  const key = String(tableId);
  if (!sessions.has(key)) sessions.set(key, new TableSession(tableId));
  return sessions.get(key);
}

function persistSessions() {
  try {
    saveSessions(sessions);
  } catch (err) {
    console.warn('[oracle] session persist failed:', err.message ?? err);
  }
}

function parsePlayTable(raw) {
  const players = raw.players.map((p) => ({
    addr: p.addr,
    chips: p.chips,
    bet: p.bet,
    cardCount: Number(p.cardCount),
    isActive: p.isActive,
    hasActed: p.hasActed,
    busted: Boolean(p.busted)
  }));
  return {
    id: Number(raw.id),
    phase: Number(raw.phase),
    deckIndex: Number(raw.deckIndex),
    pendingKind: Number(raw.pendingKind),
    pendingPlayer: raw.pendingPlayer,
    players,
    dealer: {
      cardCount: Number(raw.dealer.cardCount),
      hasFinished: raw.dealer.hasFinished
    }
  };
}

async function dealLikelySucceeded(contract, tableId, playBefore) {
  const after = await readPendingPlay(contract, tableId);
  return (
    after.pendingKind !== PendingKind.DealHand &&
    after.deckIndex > playBefore.deckIndex &&
    after.players.some((p) => p.cardCount > 0)
  );
}

function sessionMatchesCommitment(session, onChainCommitment) {
  if (!onChainCommitment || onChainCommitment === ethers.ZeroHash) return false;
  if (!session.deckOrder) return false;
  if (session.deckCommitment === onChainCommitment) return true;
  return deckCommitment(session.deckOrder) === onChainCommitment;
}

async function ensureSessionForCommitment(contract, tableId, play) {
  const raw = await contract.getTablePlayState(tableId);
  const onChainCommitment = raw.deckCommitment;
  if (!onChainCommitment || onChainCommitment === ethers.ZeroHash) {
    return getSession(tableId);
  }

  let session = getSession(tableId);
  if (sessionMatchesCommitment(session, onChainCommitment)) {
    if (session.deckCommitment !== onChainCommitment) {
      session.deckCommitment = onChainCommitment;
      persistSessions();
    }
    return session;
  }

  console.warn(
    `[oracle] table=${tableId} session commitment stale — reloading for ${onChainCommitment.slice(0, 12)}…`
  );

  const remembered = lookupDealSeed(onChainCommitment);
  sessions.delete(String(tableId));
  session = getSession(tableId);
  session.deckCommitment = onChainCommitment;

  if (!remembered) {
    console.error(`[oracle] table=${tableId} no stored seed for on-chain deck commitment`);
    return session;
  }

  session.dealSeed = remembered;
  const activeAddrs = play.players.filter((p) => p.bet > 0n).map((p) => p.addr);
  session.tryRecoverFromDealSeed(activeAddrs, play);
  persistSessions();
  console.log(`[oracle] table=${tableId} session restored from commitment store`);
  return session;
}

async function recoverSessionIfNeeded(contract, tableId, play) {
  const session = await ensureSessionForCommitment(contract, tableId, play);
  const active = play.players.filter((p) => p.bet > 0n);
  const activeAddrs = active.map((p) => p.addr);

  if (session.matchesPlay(play)) return true;

  let rebuilt = session.tryRebuildFromActionLog(activeAddrs, play);
  if (!rebuilt) {
    rebuilt = session.tryRecoverFromDealSeed(activeAddrs, play);
  }

  if (rebuilt) {
    persistSessions();
    console.log(`[oracle] recovered session table=${tableId}`);
    return session.matchesPlay(play);
  }

  return false;
}

async function fulfillDeal(contract, tableId, play, signer) {
  const session = getSession(tableId);
  const snapshot = session.snapshot();
  const active = play.players.filter((p) => p.bet > 0n && p.isActive);
  const seed = BigInt(`0x${crypto.randomBytes(32).toString('hex')}`);
  try {
    const calldata = session.buildDealCalldata(active, seed);
    session.dealSeed = seed.toString();
    session.deckCommitment = calldata.deckCommitment;
    rememberDealSeed(tableId, calldata.deckCommitment, seed);
    persistSessions();

    const enc = await encryptForRelayer(
      CONTRACT_ADDRESS,
      signer.address,
      calldata.allRanks,
      calldata.allSuits
    );

    await assertPendingKind(contract, tableId, PendingKind.DealHand);

    const populated = await contract.connect(signer).oracleDealHand.populateTransaction(
      tableId,
      calldata.deckCommitment,
      calldata.deckCursor,
      calldata.playerAddrs,
      enc.rankHandles,
      enc.suitHandles,
      enc.inputProof
    );
    const tx = await sendOracleTxSerialized(signer, populated);
    await tx.wait();
    const raw = await contract.getTablePlayState(tableId);
    session.deckCommitment = raw.deckCommitment;
    rememberDealSeed(tableId, raw.deckCommitment, seed);
    persistSessions();
    console.log(`[oracle] dealt hand table=${tableId} tx=${tx.hash} (encrypted inputs)`);
  } catch (err) {
    if (await dealLikelySucceeded(contract, tableId, play)) {
      const raw = await contract.getTablePlayState(tableId);
      session.deckCommitment = raw.deckCommitment;
      if (session.deckOrder && deckCommitment(session.deckOrder) === raw.deckCommitment) {
        rememberDealSeed(tableId, raw.deckCommitment, seed);
      } else {
        const remembered = lookupDealSeed(raw.deckCommitment);
        if (remembered) {
          session.dealSeed = remembered;
          rememberDealSeed(tableId, raw.deckCommitment, remembered);
        }
      }
      console.warn(`[oracle] deal table=${tableId} error after on-chain success — keeping session`);
      persistSessions();
    } else {
      session.restore(snapshot);
      persistSessions();
    }
    throw err;
  }
}

async function fulfillHitOrDouble(contract, tableId, play, kind, signer) {
  await recoverSessionIfNeeded(contract, tableId, play);
  play = await readPendingPlay(contract, tableId);
  if (play.pendingKind !== kind) {
    console.log(`[oracle] table=${tableId} ${PendingKindName[kind] ?? kind} already cleared`);
    return;
  }

  const session = getSession(tableId);
  if (!session.deckOrder) {
    throw new Error('No deck session for hit');
  }

  const player = play.pendingPlayer;
  const playerState = play.players.find((p) => p.addr.toLowerCase() === player.toLowerCase());
  if (playerState?.busted) {
    console.warn(
      `[oracle] table=${tableId} clearing stale ${PendingKindName[kind] ?? kind} — player already busted on-chain`
    );
    await assertPendingKind(contract, tableId, kind);
    const populated = await contract.connect(signer).oracleFulfillPending.populateTransaction(
      tableId, [], [], '0x', [], [], play.dealer.cardCount, false
    );
    const tx = await sendOracleTxSerialized(signer, populated);
    await tx.wait();
    return;
  }

  const preview = session.previewHit(player);
  const ranksAfterHit = session.getPlayerRanks(player).concat(preview.card.rank);
  if (isBusted(ranksAfterHit) !== preview.busted) {
    const err = new Error(
      `Bust payload mismatch table=${tableId} preview=${preview.busted} computed=${isBusted(ranksAfterHit)}`
    );
    err.code = 'ORACLE_INVALID_BUST_PAYLOAD';
    throw err;
  }

  const enc = await encryptForRelayer(CONTRACT_ADDRESS, signer.address, [preview.card.rank], [preview.card.suit]);

  await assertPendingKind(contract, tableId, kind);

  const populated = await contract.connect(signer).oracleFulfillPending.populateTransaction(
    tableId,
    enc.rankHandles,
    enc.suitHandles,
    enc.inputProof,
    [preview.busted],
    [kind === PendingKind.DoubleDown || preview.busted],
    play.dealer.cardCount,
    false
  );

  try {
    const tx = await sendOracleTxSerialized(signer, populated);
    await tx.wait();
    session.commitHit(player, preview.card, preview.nextCursor);
    persistSessions();
    console.log(`[oracle] ${PendingKindName[kind]} table=${tableId} player=${player} busted=${preview.busted}`);
  } catch (err) {
    const after = await readPendingPlay(contract, tableId);
    await recoverSessionIfNeeded(contract, tableId, after);
    if (after.pendingKind !== kind) {
      console.warn(`[oracle] ${PendingKindName[kind]} table=${tableId} landed on-chain despite send error`);
      return;
    }
    throw err;
  }
}

async function fulfillStand(contract, tableId, play, signer) {
  await recoverSessionIfNeeded(contract, tableId, play);
  play = await readPendingPlay(contract, tableId);
  if (play.pendingKind !== PendingKind.Stand) {
    console.log(`[oracle] table=${tableId} Stand already cleared`);
    return;
  }

  const actor = play.players.find((p) => p.addr.toLowerCase() === play.pendingPlayer.toLowerCase());
  if (actor?.busted) {
    console.warn(`[oracle] table=${tableId} fulfilling Stand for busted player to clear pending`);
  }

  await assertPendingKind(contract, tableId, PendingKind.Stand);

  const populated = await contract.connect(signer).oracleFulfillPending.populateTransaction(
    tableId,
    [],
    [],
    '0x',
    [],
    [],
    play.dealer.cardCount,
    false
  );

  try {
    const tx = await sendOracleTxSerialized(signer, populated);
    await tx.wait();
    console.log(`[oracle] stand table=${tableId}`);
  } catch (err) {
    const after = await readPendingPlay(contract, tableId);
    if (after.pendingKind !== PendingKind.Stand) {
      console.warn(`[oracle] stand table=${tableId} landed on-chain despite send error`);
      return;
    }
    throw err;
  }
}

async function fulfillDealerPlay(contract, tableId, play, signer) {
  await recoverSessionIfNeeded(contract, tableId, play);
  play = await readPendingPlay(contract, tableId);
  if (play.pendingKind !== PendingKind.DealerPlay) {
    console.log(`[oracle] table=${tableId} DealerPlay already cleared`);
    return;
  }

  const session = getSession(tableId);
  if (!session.deckOrder) {
    throw new Error('No deck session for dealer play');
  }
  const preview = session.previewDealerDraw();
  const newRanks = preview.newCards.map((c) => c.rank);
  const newSuits = preview.newCards.map((c) => c.suit);

  await assertPendingKind(contract, tableId, PendingKind.DealerPlay);

  let rankHandles = [];
  let suitHandles = [];
  let inputProof = '0x';
  if (newRanks.length > 0) {
    const enc = await encryptForRelayer(CONTRACT_ADDRESS, signer.address, newRanks, newSuits);
    rankHandles = enc.rankHandles;
    suitHandles = enc.suitHandles;
    inputProof = enc.inputProof;
  }

  const populated = await contract.connect(signer).oracleFulfillPending.populateTransaction(
    tableId,
    rankHandles,
    suitHandles,
    inputProof,
    [],
    [],
    preview.finalCount,
    true
  );
  try {
    const tx = await sendOracleTxSerialized(signer, populated);
    await tx.wait();
    session.commitDealerDraw(preview.newCards, preview.nextCursor);
    persistSessions();
    const ranks = session.getDealerRanks();
    console.log(`[oracle] dealer played table=${tableId} cards=${preview.before}->${ranks.length} total=${handTotal(ranks)}`);

    const settlePlay = await readPendingPlay(contract, tableId);
    if (settlePlay.pendingKind === PendingKind.Settle) {
      console.log(`[oracle] chaining settle immediately table=${tableId}`);
      await fulfillSettle(contract, tableId, settlePlay, signer);
    }
  } catch (err) {
    const after = await readPendingPlay(contract, tableId);
    await recoverSessionIfNeeded(contract, tableId, after);
    if (after.pendingKind !== PendingKind.DealerPlay) {
      console.warn(`[oracle] dealer play table=${tableId} landed on-chain despite send error`);
      return;
    }
    throw err;
  }
}

async function fulfillSettle(contract, tableId, play, signer) {
  await recoverSessionIfNeeded(contract, tableId, play);
  play = await readPendingPlay(contract, tableId);
  if (play.pendingKind !== PendingKind.Settle) {
    console.log(`[oracle] table=${tableId} Settle already cleared`);
    return;
  }

  const session = getSession(tableId);
  const active = play.players.filter((p) => p.bet > 0n);

  if (!session.matchesPlay(play)) {
    const recovered = await recoverSessionIfNeeded(contract, tableId, play);
    if (recovered) {
      console.log(`[oracle] rebuilt session for settle table=${tableId}`);
    } else {
      console.error(
        `[oracle] refusing settle table=${tableId}: session out of sync ` +
          `(dealer ${session.dealerHand.length}/${play.dealer.cardCount})`
      );
      for (const player of active) {
        const sessionCount = session.getPlayerRanks(player.addr).length;
        console.error(
          `[oracle] player ${player.addr} cards session=${sessionCount} chain=${player.cardCount}`
        );
      }
      const err = new Error('Session out of sync');
      err.code = 'ORACLE_SESSION_OUT_OF_SYNC';
      throw err;
    }
  }

  const payload = session.buildSettlePayload(active);
  const dealerRanks = session.getDealerRanks();
  const computedDealerBusted = isBusted(dealerRanks);
  const computedDealerTotal = handTotal(dealerRanks);

  if (payload.dealerBusted !== computedDealerBusted) {
    const err = new Error(
      `Dealer bust mismatch table=${tableId} payload=${payload.dealerBusted} computed=${computedDealerBusted}`
    );
    err.code = 'ORACLE_INVALID_SETTLE_PAYLOAD';
    throw err;
  }
  if (payload.dealerTotal !== computedDealerTotal) {
    const err = new Error(
      `Dealer total mismatch table=${tableId} payload=${payload.dealerTotal} computed=${computedDealerTotal}`
    );
    err.code = 'ORACLE_INVALID_SETTLE_PAYLOAD';
    throw err;
  }

  for (let i = 0; i < active.length; i++) {
    const addr = payload.players[i];
    const ranks = session.getPlayerRanks(addr);
    const expectedOutcome = resolveOutcome(ranks, dealerRanks);
    if (payload.outcomes[i] !== expectedOutcome) {
      const err = new Error(
        `Outcome mismatch table=${tableId} player=${addr} payload=${payload.outcomes[i]} expected=${expectedOutcome}`
      );
      err.code = 'ORACLE_INVALID_SETTLE_PAYLOAD';
      throw err;
    }
    if (payload.totals[i] !== handTotal(ranks)) {
      const err = new Error(
        `Player total mismatch table=${tableId} player=${addr} payload=${payload.totals[i]} computed=${handTotal(ranks)}`
      );
      err.code = 'ORACLE_INVALID_SETTLE_PAYLOAD';
      throw err;
    }
  }

  if (play.dealer.cardCount > 0 && payload.dealerTotal === 0) {
    const err = new Error(`Refusing settle with dealerTotal=0 while dealer has ${play.dealer.cardCount} cards`);
    err.code = 'ORACLE_INVALID_SETTLE_PAYLOAD';
    throw err;
  }

  const zeroTotals = payload.totals.filter((total, index) => total === 0 && active[index].cardCount > 0);
  if (zeroTotals.length > 0) {
    const err = new Error('Refusing settle with zero player totals while cards exist on-chain');
    err.code = 'ORACLE_INVALID_SETTLE_PAYLOAD';
    throw err;
  }

  await assertPendingKind(contract, tableId, PendingKind.Settle);

  const populated = await contract.connect(signer).oracleSettleWithOutcomes.populateTransaction(
    tableId,
    payload.players,
    payload.totals,
    payload.outcomes,
    payload.payouts,
    payload.dealerTotal,
    payload.dealerBusted
  );
  const tx = await sendOracleTxSerialized(signer, populated);
  const receipt = await tx.wait();
  sessions.delete(String(tableId));
  persistSessions();
  void recordHandHistoryFromContract(contract, tableId, receipt.hash, CONTRACT_ADDRESS)
    .then(() => {
      console.log(`[oracle] recorded hand history table=${tableId}`);
    })
    .catch((historyErr) => {
      console.warn(
        `[oracle] hand history record failed table=${tableId}:`,
        historyErr.shortMessage ?? historyErr.message ?? historyErr
      );
    });
  console.log(`[oracle] settled table=${tableId} tx=${tx.hash}`);
}

async function tryAutoAdvanceTimeout(contract, tableId, signer) {
  const raw = await contract.getTablePlayState(tableId);
  const play = parsePlayTable(raw);
  if (play.phase !== 2 || play.pendingKind !== PendingKind.None) return false;

  const timeout = Number(await contract.TURN_TIMEOUT());
  const lastActivity = Number(raw.lastActivityTimestamp);
  const now = Math.floor(Date.now() / 1000);
  if (now < lastActivity + timeout) return false;

  const waiting = play.players.filter((p) => p.bet > 0n && p.isActive && !p.hasActed && !p.busted);
  const populated = await contract.forceAdvanceOnTimeout.populateTransaction(tableId);
  const tx = await sendOracleTxSerialized(signer, populated);
  await tx.wait();
  if (waiting.length > 0) {
    console.log(`[oracle] auto-advanced timed-out turn table=${tableId} player=${waiting[0].addr}`);
  } else {
    console.log(`[oracle] auto-advanced timed-out table=${tableId} -> DealerPlay pending`);
  }
  return true;
}

async function recoverStuckPlayerPhase(contract, tableId, signer) {
  const play = await readPendingPlay(contract, tableId);
  if (play.phase !== 2 || play.pendingKind !== PendingKind.None) return false;

  const waiting = play.players.filter((p) => p.bet > 0n && p.isActive && !p.hasActed && !p.busted);
  if (waiting.length > 0) return false;

  const nextPlayer = await contract.getNextPlayer(tableId);
  if (nextPlayer !== ethers.ZeroAddress) return false;

  const hasBettor = play.players.some((p) => p.bet > 0n);
  if (!hasBettor) return false;

  if (typeof contract.oracleAdvanceToDealer === 'function') {
    try {
      const populated = await contract.oracleAdvanceToDealer.populateTransaction(tableId);
      const tx = await sendOracleTxSerialized(signer, populated);
      await tx.wait();
      console.log(`[oracle] recovered stuck table=${tableId} -> DealerPlay pending`);
      return true;
    } catch (err) {
      console.warn(
        `[oracle] oracleAdvanceToDealer failed table=${tableId}: ${messageFromError(err)}`
      );
    }
  }

  return tryAutoAdvanceTimeout(contract, tableId, signer);
}

async function handlePending(contract, tableId, signer) {
  const play = await readPendingPlay(contract, tableId);
  const kind = play.pendingKind;
  if (kind === PendingKind.None) {
    if (await recoverStuckPlayerPhase(contract, tableId, signer)) return true;
    if (await tryAutoAdvanceTimeout(contract, tableId, signer)) return true;
    await recoverSessionIfNeeded(contract, tableId, play);
    return false;
  }

  const fingerprint = pendingFingerprint(play);
  console.log(`[oracle] pending table=${tableId} kind=${PendingKindName[kind] ?? kind} fp=${fingerprint}`);

  switch (kind) {
    case PendingKind.DealHand:
      await fulfillDeal(contract, tableId, play, signer);
      break;
    case PendingKind.Hit:
    case PendingKind.DoubleDown:
      await fulfillHitOrDouble(contract, tableId, play, kind, signer);
      break;
    case PendingKind.Stand:
      await fulfillStand(contract, tableId, play, signer);
      break;
    case PendingKind.DealerPlay:
      await fulfillDealerPlay(contract, tableId, play, signer);
      break;
    case PendingKind.Settle:
      await fulfillSettle(contract, tableId, play, signer);
      break;
    default:
      console.warn(`[oracle] unknown pending kind ${kind}`);
  }
  return true;
}

const MAX_STEPS_PER_WAKE = Number(process.env.ORACLE_MAX_STEPS_PER_WAKE ?? 5);

async function runTableWork(contract, tableId, signer) {
  const backoffUntil = tableBackoffUntil.get(tableId) ?? 0;
  if (Date.now() < backoffUntil) return;

  try {
    for (let step = 0; step < MAX_STEPS_PER_WAKE; step++) {
      const didWork = await handlePending(contract, tableId, signer);
      if (!didWork) break;
      const play = await readPendingPlay(contract, tableId);
      if (Number(play.pendingKind) === PendingKind.None) break;
    }
    tableBackoffUntil.delete(tableId);
  } catch (err) {
    if (isBenignOracleError(err) || err.code === 'ORACLE_STALE_PENDING') {
      console.log(`[oracle] table=${tableId} skipped: ${messageFromError(err)}`);
      tableBackoffUntil.delete(tableId);
      return;
    }

    const msg = messageFromError(err);
    console.error(`[oracle] error table=${tableId}: ${msg}`);

    const backoff = isReplacementFeeError(err) ? ERROR_BACKOFF_MS * 2 : ERROR_BACKOFF_MS;
    tableBackoffUntil.set(tableId, Date.now() + backoff);

    if (err.code === 'ORACLE_SESSION_OUT_OF_SYNC' || err.code === 'ORACLE_INVALID_SETTLE_PAYLOAD') {
      console.error(
        `[oracle] table=${tableId} session recovery failed — ensure a single oracle process is running`
      );
    }
  }
}

function wakeTable(contract, signer, tableId) {
  if (tableWork.has(tableId)) return;
  const work = runTableWork(contract, tableId, signer).finally(() => {
    tableWork.delete(tableId);
  });
  tableWork.set(tableId, work);
}

async function pollTables(contract, signer) {
  const count = Number(await contract.getTablesCount());
  const work = [];
  for (let id = 1; id <= count; id++) {
    if (tableWork.has(id)) continue;
    const task = runTableWork(contract, id, signer).finally(() => {
      tableWork.delete(id);
    });
    tableWork.set(id, task);
    work.push(task);
  }
  if (work.length > 0) {
    await Promise.allSettled(work);
  }
}

function httpToWsUrl(httpUrl) {
  return httpUrl.replace(/^https:\/\//i, 'wss://').replace(/^http:\/\//i, 'ws://');
}

function startEventWatcher(contractAddress, abi, getSigner, onWake) {
  const rpcUrl = rpcPool.currentUrl();
  if (!rpcUrl) return null;

  let wsProvider;
  try {
    wsProvider = new ethers.WebSocketProvider(httpToWsUrl(rpcUrl));
  } catch (err) {
    console.warn('[oracle] WebSocket unavailable — poll-only mode:', err.message ?? err);
    return null;
  }

  const wsContract = new ethers.Contract(contractAddress, abi, wsProvider);
  wsContract.on('OracleActionRequired', (tableId, kind) => {
    const id = Number(tableId);
    const kindName = PendingKindName[Number(kind)] ?? kind;
    console.log(`[oracle] event OracleActionRequired table=${id} kind=${kindName}`);
    onWake(id);
  });

  wsProvider.on('error', (err) => {
    console.warn('[oracle] websocket error:', err?.message ?? err);
  });

  console.log(`[oracle] event watcher active via ${httpToWsUrl(rpcUrl)}`);
  return { wsProvider, wsContract };
}

async function main() {
  if (!PRIVATE_KEY) {
    console.error(
      'Set ORACLE_PRIVATE_KEY (or ALLOW_DEPLOYER_ORACLE_KEY=true with SEPOLIA_DEPLOYER_KEY for local dev only)'
    );
    process.exit(1);
  }

  try {
    acquireProcessLock(ORACLE_LOCK_PATH);
  } catch (err) {
    console.error(err.message ?? err);
    process.exit(1);
  }
  if (!CONTRACT_ADDRESS) {
    console.error('Set BLACKJACK_CONTRACT_ADDRESS');
    process.exit(1);
  }

  let provider = rpcPool.getProvider();
  let signer = new ethers.Wallet(PRIVATE_KEY, provider);
  const artifact = require('../artifacts/contracts/Blackjack.sol/Blackjack.json');
  let contract = new ethers.Contract(CONTRACT_ADDRESS, artifact.abi, signer);

  const network = await provider.getNetwork();
  const bytecode = await provider.getCode(CONTRACT_ADDRESS);
  if (!bytecode || bytecode === '0x') {
    console.error(
      `No contract bytecode at ${CONTRACT_ADDRESS} on chainId=${network.chainId}. ` +
        'Check BLACKJACK_CONTRACT_ADDRESS and ORACLE_RPC_URL point to the same network.'
    );
    process.exit(1);
  }

  let oracleAddr;
  try {
    oracleAddr = await contract.gameOracle();
  } catch (err) {
    console.error(
      `Contract at ${CONTRACT_ADDRESS} does not respond to gameOracle() on chainId=${network.chainId}. ` +
        'The address may be a wallet or an unrelated contract — use the deployed Blackjack address from npm run deploy.'
    );
    console.error(err.shortMessage ?? err.message ?? err);
    process.exit(1);
  }
  if (oracleAddr.toLowerCase() !== signer.address.toLowerCase()) {
    console.error(`Signer ${signer.address} is not gameOracle (${oracleAddr})`);
    process.exit(1);
  }

  console.log(`[oracle] polling contract=${CONTRACT_ADDRESS} signer=${signer.address}`);
  console.log(`[oracle] rpc=${rpcPool.currentUrl()} chainId=${network.chainId} interval=${POLL_INTERVAL_MS}ms`);
  console.log(`[oracle] rpc fallbacks=${rpcPool.urls.length}`);
  console.log(`[oracle] max steps per wake=${MAX_STEPS_PER_WAKE}`);

  getRelayerInstance()
    .then(() => console.log('[oracle] FHE relayer pre-warmed'))
    .catch((err) => {
      console.warn('[oracle] FHE relayer pre-warm failed:', err.message ?? err);
    });

  const activityServer = startActivityServer();

  const runtime = { contract, signer };

  const onEventWake = (tableId) => {
    wakeTable(runtime.contract, runtime.signer, tableId);
  };

  let eventWatcher = startEventWatcher(CONTRACT_ADDRESS, artifact.abi, () => runtime.signer, onEventWake);

  await pollTables(contract, signer);

  const timer = setInterval(() => {
    pollTables(contract, signer).catch((err) => {
      if (rpcPool.isRetryableRpcError(err)) {
        rpcPool.rotate(err.shortMessage ?? err.message ?? 'rpc error');
        provider = rpcPool.getProvider();
        signer = new ethers.Wallet(PRIVATE_KEY, provider);
        contract = new ethers.Contract(CONTRACT_ADDRESS, artifact.abi, signer);
        runtime.signer = signer;
        runtime.contract = contract;
        if (eventWatcher) {
          eventWatcher.wsContract.removeAllListeners();
          eventWatcher.wsProvider.destroy().catch(() => {});
        }
        eventWatcher = startEventWatcher(CONTRACT_ADDRESS, artifact.abi, () => signer, onEventWake);
      }
      console.error('[oracle] poll error:', err.shortMessage ?? err.message ?? err);
    });
  }, POLL_INTERVAL_MS);

  const shutdown = () => {
    clearInterval(timer);
    if (eventWatcher) {
      eventWatcher.wsContract.removeAllListeners();
      eventWatcher.wsProvider.destroy().catch(() => {});
    }
    if (activityServer) {
      activityServer.close(() => {
        releaseProcessLock(ORACLE_LOCK_PATH);
        console.log('[oracle] stopped');
        process.exit(0);
      });
      return;
    }
    releaseProcessLock(ORACLE_LOCK_PATH);
    console.log('[oracle] stopped');
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});