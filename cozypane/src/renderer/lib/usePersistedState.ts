import { useState, useEffect, useRef } from 'react';
import type { Dispatch, SetStateAction } from 'react';

// Persisted-state hook. Combines `useState` with a `useEffect` that syncs
// the value to localStorage under `cozyPane:<key>`.
//
// `opts.skipSave` — optional gate. Called before every save; when it
// returns `true`, the save is skipped. Captured via a ref so it reads the
// latest closure without the hook re-subscribing. Used by `panelWidth` /
// `previewWidth` to avoid writing on every pixel during an active drag.

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
    /* quota exceeded or serialization error — non-fatal */
  }
}

export interface UsePersistedStateOptions {
  skipSave?: () => boolean;
}

export function usePersistedState<T>(
  key: string,
  fallback: T,
  opts?: UsePersistedStateOptions,
): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => loadPersisted<T>(key, fallback));

  const skipSaveRef = useRef(opts?.skipSave);
  skipSaveRef.current = opts?.skipSave;

  // Skip the first effect — it would write back the value we just loaded
  // from localStorage, costing one JSON.stringify + setItem per persisted
  // key on every app launch.
  const isFirstSave = useRef(true);

  useEffect(() => {
    if (isFirstSave.current) {
      isFirstSave.current = false;
      return;
    }
    if (skipSaveRef.current?.()) return;
    savePersisted(key, value);
  }, [key, value]);

  return [value, setValue];
}
