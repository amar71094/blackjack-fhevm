import { CIPHERJACK_X_URL, ZAMA_FHEVM_DOCS_URL } from '@/lib/gameConstants';

export const SiteFooter = () => (
  <footer className="mt-10 space-y-3 border-t border-white/10 px-4 py-8 text-center">
    <p className="text-xs uppercase tracking-[0.35em] text-white/50">
      © {new Date().getFullYear()} CipherJack · Built on{' '}
      <a
        href={ZAMA_FHEVM_DOCS_URL}
        target="_blank"
        rel="noreferrer"
        className="text-primary/80 underline decoration-primary/30 underline-offset-4 hover:text-primary"
      >
        Zama fhEVM
      </a>
      {' '}· Sepolia testnet
    </p>
    <div className="flex flex-wrap items-center justify-center gap-4 text-[0.65rem] uppercase tracking-[0.28em]">
      <a
        href={ZAMA_FHEVM_DOCS_URL}
        target="_blank"
        rel="noreferrer"
        className="text-white/55 hover:text-white"
      >
        FHEVM Docs
      </a>
      <a
        href={CIPHERJACK_X_URL}
        target="_blank"
        rel="noreferrer"
        className="text-white/55 hover:text-white"
      >
        @CipherJack_FHE
      </a>
    </div>
  </footer>
);