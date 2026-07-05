const { ethers } = require('ethers');

const DEFAULT_SEPOLIA_RPCS = [
  'https://ethereum-sepolia-rpc.publicnode.com',
  'https://rpc.sepolia.org',
  'https://1rpc.io/sepolia'
];

function parseRpcList() {
  const primary = process.env.ORACLE_RPC_URL || process.env.SEPOLIA_RPC_URL;
  const extras = (process.env.ORACLE_RPC_FALLBACKS || '')
    .split(',')
    .map((url) => url.trim())
    .filter(Boolean);
  const merged = [primary, ...extras, ...DEFAULT_SEPOLIA_RPCS].filter(Boolean);
  return [...new Set(merged)];
}

function isRetryableRpcError(err) {
  const msg = String(err?.shortMessage ?? err?.message ?? err).toLowerCase();
  return (
    /rate|429|too many|timeout|timed out|econnreset|enotfound|network|fetch failed|replacement fee/i.test(
      msg
    )
  );
}

function createFallbackProvider() {
  const urls = parseRpcList();
  let index = 0;

  const currentUrl = () => urls[index % urls.length];

  const getProvider = () =>
    new ethers.JsonRpcProvider(currentUrl(), undefined, {
      staticNetwork: true
    });

  const rotate = (reason) => {
    const previous = currentUrl();
    index = (index + 1) % urls.length;
    console.warn(`[oracle] rotating RPC ${previous} -> ${currentUrl()} (${reason})`);
  };

  return {
    urls,
    currentUrl,
    getProvider,
    rotate,
    isRetryableRpcError
  };
}

module.exports = {
  createFallbackProvider,
  isRetryableRpcError
};