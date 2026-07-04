/**
 * Persist in-progress oracle deck sessions so restarts mid-hand do not corrupt deals.
 */
const fs = require('fs');
const path = require('path');
const { TableSession } = require('./gameEngine');

const STORE_PATH = path.join(__dirname, '.sessions.json');

function loadSessions() {
  const map = new Map();
  if (!fs.existsSync(STORE_PATH)) return map;
  try {
    const raw = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    for (const [key, data] of Object.entries(raw)) {
      const session = new TableSession(Number(key));
      session.deckOrder = data.deckOrder ?? null;
      session.deckIndex = data.deckIndex ?? 0;
      session.dealerHand = data.dealerHand ?? [];
      session.playerHands = new Map(Object.entries(data.playerHands ?? {}));
      session.actionLog = data.actionLog ?? [];
      session.dealSeed = data.dealSeed ?? null;
      session.deckCommitment = data.deckCommitment ?? null;
      map.set(key, session);
    }
  } catch {
    return new Map();
  }
  return map;
}

function saveSessions(sessions) {
  const out = {};
  for (const [key, session] of sessions.entries()) {
    if (!session.deckOrder && !session.dealSeed) continue;
    out[key] = {
      deckOrder: session.deckOrder,
      deckIndex: session.deckIndex,
      dealerHand: session.dealerHand,
      playerHands: Object.fromEntries(session.playerHands),
      actionLog: session.actionLog ?? [],
      dealSeed: session.dealSeed ?? null,
      deckCommitment: session.deckCommitment ?? null
    };
  }
  fs.writeFileSync(STORE_PATH, JSON.stringify(out, null, 2));
}

module.exports = { loadSessions, saveSessions, STORE_PATH };