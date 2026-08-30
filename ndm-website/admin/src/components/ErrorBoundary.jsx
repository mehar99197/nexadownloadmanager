import { Component } from 'react';

/**
 * ErrorBoundary — catches render errors below it and shows a friendly message
 * with a reload button instead of a blank panel.
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
      <div className="flex min-h-screen items-center justify-center p-6 text-admin-text">
        <div className="admin-card w-full max-w-md !p-8 text-center">
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-admin-cyan">Control room</p>
          <h1 className="mt-2 text-2xl font-extrabold tracking-tight">Something went wrong</h1>
          <p className="mt-3 text-sm leading-6 text-admin-muted">
            The panel hit an error it couldn&apos;t recover from. Reloading usually fixes it; if it
            keeps happening, check the browser console and the backend logs.
          </p>
          <div className="mt-6 flex justify-center gap-2">
            <button type="button" className="btn-admin-primary" onClick={() => window.location.reload()}>
              Reload
            </button>
            <a href="/admin/dashboard" className="btn-admin-secondary">Dashboard</a>
          </div>
        </div>
      </div>
    );
  }
}
