import { createContext, useContext, useEffect } from 'react';
import { useLocalStorage } from '../hooks/useLocalStorage';

const ThemeContext = createContext(null);

/**
 * Theme is either 'light' ("day porch"), 'dark' ("evening porch"),
 * or null (follow the system preference - see index.css). Storing
 * null vs an explicit choice lets a first-time visitor get the
 * system-appropriate look before they've ever touched the toggle.
 */
export function ThemeProvider({ children }) {
  const [theme, setTheme] = useLocalStorage('porchlight-theme', null);

  useEffect(() => {
    if (theme) {
      document.documentElement.setAttribute('data-theme', theme);
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
  }, [theme]);

  const toggleTheme = () => {
    const current =
      theme || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    setTheme(current === 'dark' ? 'light' : 'dark');
  };

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme }}>{children}</ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within a ThemeProvider');
  return ctx;
}
