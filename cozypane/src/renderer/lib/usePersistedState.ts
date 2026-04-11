import { useState, useEffect, useRef } from 'react';
import type { Dispatch, SetStateAction } from 'react';

// Persisted-state hook. Combines a `useState` slice with a matching
// `useEffect` that syncs the value to localStorage under `cozyPane:<key>`.
// Addresses audit finding H19 (App.tsx had 14 nearly-identical
// useState + useEffect pairs for settings that survive quit/reopen).
//
// Usage:
//   const [panelWidth, setPanelWidth] = usePersistedState('panelWidth', 360);
//
// The hook loads the initial value from localStorage (if present) on
// first render. Writes are JSON-serialized and throttled only in the
// sense that React batches state updates; every committed state change
// writes through to localStorage.
//
// `opts.skipSave` — optional gate. Called before every save; when it
// returns true, the save is skipped. Useful for persisting only the
// "final" value of an interactive setting like panelWidth, which should
// NOT be written on every pixel during a drag. Example:
//   const [panelWidth, setPanelWidth] = usePersistedState(
//     'panelWidth',
//     360,
//     { skipSave: () => isResizingRef.current },
//   );
//
// The `skipSave` function is captured via a ref so it can read the
// latest value of closures without the hook re-subscribing.

const PREFIX = 'cozyPane:';

function loadPersisted<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (raw === null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function savePersisted(key: string, value: unknown): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // localStorage quota exceeded or serialization error — non-fatal,
    // same failure mode as the original hand-rolled saves.
  }
}

export interface UsePersistedStateOptions {
  /**
   * Optional gate called before each save. Return `true` to skip writing
   * the current value to localStorage (e.g. during active drag resize).
   * Reads the latest closure via a ref, so the caller doesn't need to
   * memoize it.
   */
  skipSave?: () => boolean;
}

export function usePersistedState<T>(
  key: string,
  fallback: T,
  opts?: UsePersistedStateOptions,
): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => loadPersisted<T>(key, fallback));

  // Stash the skipSave predicate in a ref so the save effect can read
  // the latest closure without the effect re-running when the caller
  // re-creates its function.
  const skipSaveRef = useRef(opts?.skipSave);
  skipSaveRef.current = opts?.skipSave;

  useEffect(() => {
    if (skipSaveRef.current?.()) return;
    savePersisted(key, value);
  }, [key, value]);

  return [value, setValue];
}
