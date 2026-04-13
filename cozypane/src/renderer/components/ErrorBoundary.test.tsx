import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ErrorBoundary from './ErrorBoundary';

// Mock Sentry
vi.mock('@sentry/electron/renderer', () => ({
  captureException: vi.fn(),
}));

// Suppress console.error from React error boundary logging
const originalError = console.error;
beforeEach(() => {
  console.error = vi.fn();
});
afterEach(() => {
  console.error = originalError;
});

function GoodChild() {
  return <div>All good</div>;
}

function ThrowingChild({ message }: { message: string }) {
  throw new Error(message);
}

describe('ErrorBoundary', () => {
  it('renders children normally when no error', () => {
    render(
      <ErrorBoundary>
        <GoodChild />
      </ErrorBoundary>
    );
    expect(screen.getByText('All good')).toBeInTheDocument();
  });

  it('catches error and shows full-page fallback UI', () => {
    render(
      <ErrorBoundary>
        <ThrowingChild message="Test crash" />
      </ErrorBoundary>
    );
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    expect(screen.getByText('Test crash')).toBeInTheDocument();
    expect(screen.getByText('Reload')).toBeInTheDocument();
  });

  it('shows panel-level fallback when panel prop is set', () => {
    render(
      <ErrorBoundary panel="Preview">
        <ThrowingChild message="Panel crash" />
      </ErrorBoundary>
    );
    expect(screen.getByText('Preview crashed')).toBeInTheDocument();
    expect(screen.getByText('Panel crash')).toBeInTheDocument();
    expect(screen.getByText('Retry')).toBeInTheDocument();
  });

  it('recovers when Retry is clicked (panel mode)', () => {
    // Use a stateful wrapper to control whether the child throws
    let shouldThrow = true;

    function ConditionalChild() {
      if (shouldThrow) throw new Error('Panel crash');
      return <div>Recovered</div>;
    }

    const { rerender } = render(
      <ErrorBoundary panel="Preview">
        <ConditionalChild />
      </ErrorBoundary>
    );

    expect(screen.getByText('Preview crashed')).toBeInTheDocument();

    // Stop throwing and click retry
    shouldThrow = false;
    fireEvent.click(screen.getByText('Retry'));

    expect(screen.getByText('Recovered')).toBeInTheDocument();
  });

  it('reports error to Sentry', async () => {
    const Sentry = await import('@sentry/electron/renderer');

    render(
      <ErrorBoundary>
        <ThrowingChild message="Sentry test" />
      </ErrorBoundary>
    );

    expect(Sentry.captureException).toHaveBeenCalled();
  });
});
