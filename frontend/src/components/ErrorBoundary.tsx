import { Component, type ErrorInfo, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[CipherJack] UI error', error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background px-6 text-center">
          <h1 className="text-2xl font-bold text-foreground">CipherJack hit a snag</h1>
          <p className="max-w-md text-sm text-muted-foreground">
            Try reloading the page. If the issue continues, reconnect your wallet and try again.
          </p>
          <button
            type="button"
            className="rounded-full border border-primary/40 bg-primary/10 px-4 py-2 text-sm font-semibold text-primary"
            onClick={() => window.location.reload()}
          >
            Reload
          </button>
        </main>
      );
    }

    return this.props.children;
  }
}