import React from 'react';

interface Props {
  children: React.ReactNode;
  /** When set, renders a compact panel-level fallback instead of the full-page reload UI */
  panel?: string;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export default class ErrorBoundary extends React.Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[CozyPane] React error:', error, info.componentStack);
  }

  private handleRetry = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.panel) {
        return (
          <div style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            height: '100%', background: 'var(--bg-primary)', color: 'var(--text-primary)', fontFamily: 'monospace', padding: '1.5em',
          }}>
            <div style={{ fontSize: '1em', marginBottom: 8 }}>{this.props.panel} crashed</div>
            <pre style={{ color: 'var(--danger)', fontSize: 12, maxWidth: '90%', overflow: 'auto', marginBottom: 14, textAlign: 'center' }}>
              {this.state.error?.message}
            </pre>
            <button
              onClick={this.handleRetry}
              style={{
                padding: '6px 16px', background: 'var(--accent)', color: '#fff',
                border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 13,
              }}
            >
              Retry
            </button>
          </div>
        );
      }

      return (
        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          height: '100vh', background: 'var(--bg-primary)', color: 'var(--text-primary)', fontFamily: 'monospace',
        }}>
          <h2 style={{ marginBottom: 12 }}>Something went wrong</h2>
          <pre style={{ color: 'var(--danger)', fontSize: 13, maxWidth: '80%', overflow: 'auto', marginBottom: 20 }}>
            {this.state.error?.message}
          </pre>
          <button
            onClick={() => window.location.reload()}
            style={{
              padding: '8px 20px', background: 'var(--accent)', color: '#fff',
              border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 14,
            }}
          >
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
