const { Outcome } = require('./gameEngine');
const { appendHandHistory, normalizeEntry } = require('./handHistoryStore');

function buildEntryFromLastHandResult(handResult, txHash) {
  const timestamp = Number(handResult?.timestamp ?? 0n);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;

  const results = handResult?.results ?? [];
  const winners = [];

  for (const result of results) {
    const outcome = Number(result?.outcome ?? result?.[3] ?? -1);
    const payout = Number(result?.payout ?? result?.[4] ?? 0n);
    const address = String(result?.addr ?? result?.[0] ?? '').toLowerCase();
    if (!/^0x[a-f0-9]{40}$/.test(address)) continue;
    if (payout <= 0) continue;
    if (outcome !== Outcome.Win && outcome !== Outcome.Blackjack) continue;
    winners.push({ address, payout });
  }

  return normalizeEntry({
    timestamp,
    pot: Number(handResult?.pot ?? 0n),
    dealerWon: winners.length === 0,
    winners,
    txHash
  });
}

async function recordHandHistoryFromContract(contract, tableId, txHash, contractAddress) {
  const [dealerTotal, dealerBusted, results, pot, timestamp] = await contract.getLastHandResult(tableId);
  const entry = buildEntryFromLastHandResult(
    {
      dealerTotal,
      dealerBusted,
      results,
      pot,
      timestamp
    },
    txHash
  );
  if (!entry) return null;
  return appendHandHistory(tableId, entry, contractAddress ?? contract.target);
}

module.exports = {
  buildEntryFromLastHandResult,
  recordHandHistoryFromContract
};