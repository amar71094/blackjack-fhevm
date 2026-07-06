/**
 * Persistent per-table hand activity (last N completed hands).
 * Indexed by the oracle after each settle; served via activityServer.
 */
const fs = require('fs');
const path = require('path');
const { atomicWriteJson } = require('./atomicStore');

const STORE_PATH = path.join(__dirname, '.hand-history.json');
const MAX_HANDS_PER_TABLE = Number(process.env.ORACLE_ACTIVITY_MAX_HANDS ?? 100);

function emptyStore(contractAddress = '') {
  return {
    contract: contractAddress ? String(contractAddress).toLowerCase() : '',
    updatedAt: null,
    tables: {}
  };
}

function loadStore() {
  if (!fs.existsSync(STORE_PATH)) return emptyStore();
  try {
    const raw = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    if (!raw || typeof raw !== 'object') return emptyStore();
    return {
      contract: typeof raw.contract === 'string' ? raw.contract : '',
      updatedAt: raw.updatedAt ?? null,
      tables: raw.tables && typeof raw.tables === 'object' ? raw.tables : {}
    };
  } catch {
    return emptyStore();
  }
}

function saveStore(store) {
  store.updatedAt = new Date().toISOString();
  atomicWriteJson(STORE_PATH, store);
}

function tableKey(tableId) {
  return String(tableId);
}

function normalizeEntry(entry) {
  const timestamp = Number(entry?.timestamp ?? 0);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;

  const winners = Array.isArray(entry?.winners)
    ? entry.winners
        .map((winner) => ({
          address: String(winner?.address ?? '').toLowerCase(),
          payout: Number(winner?.payout ?? 0)
        }))
        .filter((winner) => /^0x[a-f0-9]{40}$/.test(winner.address) && winner.payout > 0)
    : [];

  return {
    timestamp,
    pot: Number(entry?.pot ?? 0),
    dealerWon: Boolean(entry?.dealerWon ?? winners.length === 0),
    winners,
    txHash: typeof entry?.txHash === 'string' ? entry.txHash : undefined
  };
}

function ensureContract(store, contractAddress) {
  const normalized = String(contractAddress ?? '').toLowerCase();
  if (!normalized) return store;
  if (!store.contract) {
    store.contract = normalized;
    return store;
  }
  if (store.contract !== normalized) {
    return {
      contract: normalized,
      updatedAt: null,
      tables: {}
    };
  }
  return store;
}

function appendHandHistory(tableId, entry, contractAddress) {
  const normalized = normalizeEntry(entry);
  if (!normalized) return null;

  const store = ensureContract(loadStore(), contractAddress);
  const key = tableKey(tableId);
  const existing = Array.isArray(store.tables[key]) ? store.tables[key] : [];

  if (existing.some((hand) => hand.timestamp === normalized.timestamp)) {
    return existing;
  }

  const next = [normalized, ...existing].slice(0, MAX_HANDS_PER_TABLE);
  store.tables[key] = next;
  saveStore(store);
  return next;
}

function getHandHistory(tableId, limit = MAX_HANDS_PER_TABLE) {
  const store = loadStore();
  const key = tableKey(tableId);
  const rows = Array.isArray(store.tables[key]) ? store.tables[key] : [];
  const capped = Math.max(1, Math.min(Number(limit) || MAX_HANDS_PER_TABLE, MAX_HANDS_PER_TABLE));
  return rows.slice(0, capped);
}

function listTableIds() {
  const store = loadStore();
  return Object.keys(store.tables)
    .map((id) => Number(id))
    .filter((id) => Number.isFinite(id) && id > 0)
    .sort((a, b) => a - b);
}

module.exports = {
  STORE_PATH,
  MAX_HANDS_PER_TABLE,
  loadStore,
  appendHandHistory,
  getHandHistory,
  listTableIds,
  normalizeEntry
};