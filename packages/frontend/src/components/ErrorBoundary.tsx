import React from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { userMessage } from '../services/errors';

interface ErrorBoundaryProps {
  children: React.ReactNode;
  /**
   * What part of the app this boundary protects, in the words an operator would use — it is shown
   * to them ("This screen could not be displayed"), so "the planning desk" reads better than
   * "PlanningWorkspace".
   */
  area: string;
  /**
   * Changing this value clears the error and remounts the subtree. The router passes the current
   * path, so navigating away from a broken screen recovers on its own instead of leaving the
   * person stuck on an error panel that outlives the thing that caused it.
   */
  resetKey?: string;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Stops one bad render from taking the whole application down.
 *
 * There was no error boundary anywhere in this app. React's documented behaviour for an
 * uncaught render error is to unmount the entire root, so a single undefined lookup in one panel
 * left every user staring at a blank white page with no header, no navigation and no way back
 * except knowing to reload. That is not hypothetical here: `services/api.ts` still carries the
 * note about the notification-preferences tab, where a shared enum gained an eighth member, a
 * `CATEGORY_META[...]` lookup came back undefined, and dereferencing it blanked the page for
 * every signed-in user — a cosmetic mismatch in one tab presenting as a total outage.
 *
 * A boundary turns that class of failure into "this panel is broken, the rest of the app still
 * works", which is both the honest description and the one someone can act on. The console still
 * receives the real error and stack; only the user-facing surface is softened.
 *
 * Deliberately a class component: `getDerivedStateFromError`/`componentDidCatch` have no hooks
 * equivalent, and every "error boundary hook" is really this class in a wrapper.
 */
export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidUpdate(prevProps: ErrorBoundaryProps) {
    // Recover on navigation. Without this the boundary latches: the router swaps the children for
    // a different screen, but this component is still holding the error from the previous one and
    // keeps rendering the fallback, so the whole app appears permanently broken after one bad
    // render and the only escape is a reload.
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      this.reset();
    }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // The point of catching is not to hide the failure — it is to stop it cascading. The full
    // error and the component stack still reach the console, which is where anyone diagnosing a
    // report ("the billing tab went white") will look first.
    console.error(`[ErrorBoundary] ${this.props.area} failed to render:`, error, info.componentStack);
  }

  private reset = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div
        role="alert"
        style={{
          margin: '24px auto',
          maxWidth: '640px',
          padding: '24px',
          background: 'var(--bg-secondary)',
          border: '1px solid var(--border-color)',
          borderRadius: 'var(--radius-md)',
          display: 'flex',
          flexDirection: 'column',
          gap: '12px',
          color: 'var(--text-primary)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <AlertTriangle size={20} style={{ color: 'var(--danger)', flexShrink: 0 }} />
          <h2 style={{ fontSize: '16px', fontWeight: 700, margin: 0 }}>
            {this.props.area} could not be displayed
          </h2>
        </div>
        {/*
          `userMessage` is the same translator the API layer uses, so a failure caused by a bad
          server response reads as the sentence that failure already has, and a genuine JavaScript
          crash falls back to plain wording rather than showing a stack to a bank auditor.
        */}
        <p style={{ fontSize: '13px', color: 'var(--text-secondary)', margin: 0, lineHeight: 1.5 }}>
          {userMessage(error)} Nothing you were working on has been sent to the server. The rest of
          the application is still working — you can move to another screen, or try this one again.
        </p>
        <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
          <button
            type="button"
            onClick={this.reset}
            className="btn btn-primary"
            style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '8px 16px', fontSize: '13px', fontWeight: 700 }}
          >
            <RefreshCw size={14} /> Try again
          </button>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="btn btn-secondary"
            style={{ padding: '8px 16px', fontSize: '13px', fontWeight: 600 }}
          >
            Reload the page
          </button>
        </div>
      </div>
    );
  }
}
