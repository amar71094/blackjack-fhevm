/**
 * Encrypt card ranks/suits for oracle txs via Zama relayer encrypted inputs.
 * Plaintext values never appear in transaction calldata — only handles + ZK proof.
 */

let relayerInstance = null;
let relayerInitPromise = null;

async function getRelayerInstance() {
  if (relayerInstance) return relayerInstance;
  if (relayerInitPromise) return relayerInitPromise;

  relayerInitPromise = (async () => {
    const { createInstance, SepoliaConfig } = await import('@zama-fhe/relayer-sdk/node');
    const rpc = process.env.ORACLE_RPC_URL || process.env.SEPOLIA_RPC_URL;
    if (!rpc) throw new Error('ORACLE_RPC_URL or SEPOLIA_RPC_URL required for FHE encryption');
    // Node entry uses native node-tfhe/node-tkms; initSDK exists only on the browser /web bundle.
    relayerInstance = await createInstance({ ...SepoliaConfig, network: rpc });
    return relayerInstance;
  })().catch((err) => {
    relayerInitPromise = null;
    throw err;
  });

  return relayerInitPromise;
}

/**
 * @param {object} encryptor - hre.fhevm (tests) or relayer FhevmInstance (production)
 * @param {string} contractAddress
 * @param {string} oracleAddress - must match tx signer (gameOracle)
 * @param {number[]} ranks
 * @param {number[]} suits
 */
async function encryptCardPairs(encryptor, contractAddress, oracleAddress, ranks, suits) {
  if (ranks.length !== suits.length) {
    throw new Error(`Rank/suit length mismatch: ${ranks.length} vs ${suits.length}`);
  }
  const input = encryptor.createEncryptedInput(contractAddress, oracleAddress);
  for (const rank of ranks) input.add8(rank);
  for (const suit of suits) input.add8(suit);
  const encrypted = await input.encrypt();
  const n = ranks.length;
  return {
    rankHandles: encrypted.handles.slice(0, n),
    suitHandles: encrypted.handles.slice(n, n + suits.length),
    inputProof: encrypted.inputProof
  };
}

async function encryptForRelayer(contractAddress, oracleAddress, ranks, suits) {
  const instance = await getRelayerInstance();
  return encryptCardPairs(instance, contractAddress, oracleAddress, ranks, suits);
}

module.exports = {
  encryptCardPairs,
  encryptForRelayer,
  getRelayerInstance
};