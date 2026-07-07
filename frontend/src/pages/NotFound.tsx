import { Link, useLocation } from 'react-router-dom';
import { useEffect } from 'react';
import { Button } from '@/components/ui/button';

const NotFound = () => {
  const location = useLocation();

  useEffect(() => {
    console.error('[CipherJack] 404 — unknown route:', location.pathname);
  }, [location.pathname]);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-slate-950 px-6 text-center text-white">
      <p className="text-xs uppercase tracking-[0.45em] text-primary/70">CipherJack</p>
      <h1 className="text-5xl font-black tracking-tight">Table Not Found</h1>
      <p className="max-w-md text-sm text-white/70">
        This page does not exist. Head back to the lobby to browse tables or resume your game.
      </p>
      <Button asChild className="bg-primary text-primary-foreground hover:bg-primary/90">
        <Link to="/">Back to Lobby</Link>
      </Button>
    </div>
  );
};

export default NotFound;