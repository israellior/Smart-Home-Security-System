import { createContext, useContext, useEffect, useSyncExternalStore } from 'react';
import { useLocalStorage } from '../hooks/useLocalStorage';

const ThemeContext = createContext(null);

const DARK_QUERY = '(prefers-color-scheme: dark)';

// Defined at module scope so the reference stays stable across renders -
// useSyncExternalStore re-subscribes whenever this function changes.
function subscribeToSystemTheme(onStoreChange) {
  const query = window.matchMedia?.(DARK_QUERY);
  if (!query) return () => {};
  query.addEventListener('change', onStoreChange);
  return () => query.removeEventListener('change', onStoreChange);
}

function getSystemTheme() {
  return window.matchMedia?.(DARK_QUERY).matches ? 'dark' : 'light';
}

/**
 * Theme is either 'light' ("day porch"), 'dark' ("evening porch"),
 * or null (follow the system preference - see index.css). Storing
 * null vs an explicit choice lets a first-time visitor get the
 * system-appropriate look before they've ever touched the toggle.
 */
export function ThemeProvider({ children }) {
  const [theme, setTheme] = useLocalStorage('porchlight-theme', null);

  // The OS preference is state that lives outside React and can change
  // while the app is open. Reading matchMedia().matches during render
  // (as Header used to) samples it once with nothing to trigger a
  // re-render, so the header icon would go stale the moment someone
  // flipped their system theme. useSyncExternalStore subscribes properly.
  const systemTheme = useSyncExternalStore(subscribeToSystemTheme, getSystemTheme);

  // The single answer to "which theme is actually showing right now",
  // for the null/follow-the-system case as well as an explicit choice.
  const resolvedTheme = theme || systemTheme;

  useEffect(() => {
    // Deliberately keyed on `theme`, not `resolvedTheme`: with no explicit
    // choice we remove the attribute entirely and let the CSS media query
    // in index.css decide, rather than pinning it from JS.
    if (theme) {
      document.documentElement.setAttribute('data-theme', theme);
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
  }, [theme]);

  const toggleTheme = () => {
    setTheme(resolvedTheme === 'dark' ? 'light' : 'dark');
  };

  return (
    <ThemeContext.Provider value={{ theme, resolvedTheme, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within a ThemeProvider');
  return ctx;
}
