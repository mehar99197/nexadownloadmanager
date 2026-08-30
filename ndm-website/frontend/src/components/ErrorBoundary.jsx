import { Component } from 'react';

/**
 * ErrorBoundary — catches render errors anywhere below it and shows a friendly
 * message with a reload button instead of a blank page.
 */
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    if (import.meta.env.DEV) {
      console.error('Unhandled render error:', error, info?.componentStack);
    }
  }

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <div className="flex min-h-dvh items-center justify-center px-5">
        <div className="card auth-card w-full max-w-md !p-8 text-center">
          <span className="eyebrow"><span className="eyebrow-dot" />Signal lost</span>
          <h1 className="mt-4 text-2xl font-bold text-white">Something went wrong</h1>
          <p className="mt-3 text-sm leading-6 text-slate-400">
            The page hit an error it couldn&apos;t recover from. Reloading usually
            fixes it. If it keeps happening, tell us at{' '}
            <a href="mailto:support@nexadownloadmanager.com" className="text-brand-300 hover:underline">
              support@nexadownloadmanager.com
            </a>
            .
          </p>
          <div className="mt-6 flex justify-center gap-3">
            <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
              Reload page
            </button>
            <a href="/" className="btn btn-ghost">Back home</a>
          </div>
        </div>
      </div>
    );
  }
}
