import React, { createContext, useCallback, useContext, useState } from 'react';
import ConfirmDialog from '../components/ConfirmDialog';

// React context for the themed confirm dialog. Lets any component call
// `useConfirm()(options)` and await a boolean result — same semantics as
// `window.confirm()` but with cozy theming and no renderer freeze.
// Audit M45.

export interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
}

type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

interface State {
  opts: ConfirmOptions;
  resolve: (v: boolean) => void;
}

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<State | null>(null);

  const confirm = useCallback<ConfirmFn>((opts) => {
    return new Promise<boolean>((resolve) => {
      setState({ opts, resolve });
    });
  }, []);

  const handleConfirm = useCallback(() => {
    state?.resolve(true);
    setState(null);
  }, [state]);

  const handleCancel = useCallback(() => {
    state?.resolve(false);
    setState(null);
  }, [state]);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <ConfirmDialog
        open={!!state}
        title={state?.opts.title || ''}
        message={state?.opts.message || ''}
        confirmLabel={state?.opts.confirmLabel}
        cancelLabel={state?.opts.cancelLabel}
        destructive={state?.opts.destructive}
        onConfirm={handleConfirm}
        onCancel={handleCancel}
      />
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): ConfirmFn {
  const confirm = useContext(ConfirmContext);
  if (!confirm) {
    // Not inside a provider — fall back to the native confirm so the code
    // still works (e.g. during early boot or in isolated test renders).
    return (opts) => Promise.resolve(window.confirm(`${opts.title}\n\n${opts.message}`));
  }
  return confirm;
}
