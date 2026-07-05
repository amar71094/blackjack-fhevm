/**
 * Maps on-chain deck commitments to the oracle deal seed so sessions can be rebuilt
 * after restarts even when in-memory hands were lost.
 */
const fs = require('fs');
const path = require('path');
const { atomicWriteJson } = require('./atomicStore');

const STORE_PATH = path.join(__dirname, '.commitment-seeds.json');

function loadStore() {
  if (!fs.existsSync(STORE_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function rememberDealSeed(tableId, deckCommitment, dealSeed) {
  if (!deckCommitment || !dealSeed) return;
  const store = loadStore();
  store[deckCommitment] = { dealSeed: String(dealSeed), tableId: String(tableId), savedAt: Date.now() };
  atomicWriteJson(STORE_PATH, store);
}

function lookupDealSeed(deckCommitment) {
  if (!deckCommitment) return null;
  const store = loadStore();
  const entry = store[deckCommitment];
  return entry?.dealSeed ?? null;
}

module.exports = { rememberDealSeed, lookupDealSeed, STORE_PATH };