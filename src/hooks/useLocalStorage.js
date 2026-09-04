import { useState, useCallback } from 'react';

/**
 * Small wrapper around localStorage that behaves like useState.
 * Wrapped in try/catch because localStorage can be unavailable
 * (private browsing, embedded iframes, etc.) - in that case the
 * app should still work, it just won't remember anything.
 */
export function useLocalStorage(key, initialValue) {
  const [value, setValue] = useState(() => {
    try {
      const stored = window.localStorage.getItem(key);
      return stored !== null ? JSON.parse(stored) : initialValue;
    } catch (err) {
      return initialValue;
    }
  });

  const update = useCallback(
    (next) => {
      setValue((prev) => {
        const resolved = typeof next === 'function' ? next(prev) : next;
        try {
          window.localStorage.setItem(key, JSON.stringify(resolved));
        } catch (err) {
          // Storage unavailable - fail silently, state still updates in memory.
        }
        return resolved;
      });
    },
    [key]
  );

  return [value, update];
}
