export const TestnetBanner = () => (
  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-sky-400/30 bg-sky-500/10 px-4 py-2 text-xs text-sky-100">
    <span className="font-semibold uppercase tracking-[0.2em] text-sky-200">Sepolia Testnet</span>
    <span className="hidden text-white/40 sm:inline">·</span>
    <span className="text-white/85">Play chips only — not real money</span>
    <span className="hidden text-white/40 sm:inline">·</span>
    <span className="text-white/85">Encrypted on-chain hands via Zama fhEVM</span>
  </div>
);