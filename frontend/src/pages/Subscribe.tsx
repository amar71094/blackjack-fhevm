import { Button } from '@/components/ui/button';
import EncryptionOrb from '@/components/subscribe/EncryptionOrb';
import background from '@/assets/subscribe-bg2.png';

const X_HANDLE = '@CipherJack_FHE';
const X_URL = 'https://x.com/CipherJack_FHE';

const Subscribe = () => {
  return (
    <div
      className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden"
      style={{
        backgroundImage: `linear-gradient(rgba(6,14,24,0.76), rgba(6,14,24,0.76)), url(${background})`,
        backgroundSize: 'cover',
        backgroundPosition: 'center'
      }}
    >
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(255,215,128,0.18),transparent_60%)]" />

      <div className="fixed top-0 z-10 w-full overflow-hidden border-b border-white/10 bg-black/40 backdrop-blur">
        <div className="marquee">
          <div className="marquee-track py-2 text-xs sm:py-3 sm:text-sm">
            {Array.from({ length: 10 }).map((_, index) => (
              <span key={index} className="marquee-message">
                We’re launching soon — follow{' '}
                <a href={X_URL} target="_blank" rel="noreferrer" className="text-amber-200 underline decoration-amber-200/50 underline-offset-4">
                  {X_HANDLE}
                </a>{' '}
                on X for updates.
              </span>
            ))}
          </div>
        </div>
      </div>

      <div className="relative z-10 mt-28 flex flex-col items-center gap-6 px-4 text-center text-slate-100 sm:mt-24 sm:px-0">
        <EncryptionOrb />

        <div className="w-full max-w-lg rounded-3xl border border-white/15 bg-black/35 px-6 py-10 shadow-[0_30px_70px_-30px_rgba(0,0,0,0.9)] backdrop-blur sm:px-10 sm:py-12">
          <h1 className="text-2xl font-black tracking-tight text-white sm:text-4xl">CipherJack is launching soon</h1>
          <p className="mt-4 text-sm text-slate-200/85 sm:text-base">
            We’re putting the finishing touches on the tables and stacking fresh chip drops. Keep an eye on our X feed for the launch countdown and early-access codes.
          </p>
          <div className="mt-8 flex justify-center">
            <Button
              asChild
              size="lg"
              className="border border-amber-200/60 bg-black/70 text-amber-200 hover:bg-black/60"
            >
              <a href={X_URL} target="_blank" rel="noreferrer">
                Follow us on X
              </a>
            </Button>
          </div>
        </div>

        <p className="text-[0.65rem] uppercase tracking-[0.45em] text-slate-200/60 sm:text-xs">© {new Date().getFullYear()} CipherJack. All rights reserved.</p>
      </div>
    </div>
  );
};

export default Subscribe;
