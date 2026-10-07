/**
 * docs-site/components/ThemeToggle.tsx
 *
 * Light / dark / system theme switch. The choice lives in localStorage and
 * in `data-theme` on <html> (absent = follow the OS); the root layout's
 * head script (THEME_SCRIPT) applies a stored choice before first paint, so
 * a page never flashes the wrong theme. The button shows all three icons
 * and CSS picks the one matching <html>, so server and client markup agree
 * whatever is stored.
 */
import React, { useEffect, useState } from 'react';

export const THEME_STORAGE_KEY = 'giojs-docs-theme';

type Theme = 'system' | 'light' | 'dark';
const ORDER: Theme[] = ['system', 'light', 'dark'];
const NAMES: Record<Theme, string> = { system: 'System', light: 'Light', dark: 'Dark' };

/**
 * Runs in <head>, before the body paints: applies the stored theme and
 * marks <html> with `js` (CSS shows script-only controls under it).
 */
export const THEME_SCRIPT = `(function(){var d=document.documentElement;d.classList.add('js');try{var t=localStorage.getItem('${THEME_STORAGE_KEY}');if(t==='light'||t==='dark')d.setAttribute('data-theme',t)}catch(e){}})();`;

function currentTheme(): Theme {
  const value = document.documentElement.getAttribute('data-theme');
  return value === 'light' || value === 'dark' ? value : 'system';
}

export function ThemeToggle(): React.JSX.Element {
  // Unknown until mounted: the server cannot see the stored choice.
  const [theme, setTheme] = useState<Theme | null>(null);
  useEffect(() => setTheme(currentTheme()), []);

  function cycle(): void {
    const next = ORDER[(ORDER.indexOf(currentTheme()) + 1) % ORDER.length] ?? 'system';
    const root = document.documentElement;
    if (next === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', next);
    try {
      if (next === 'system') localStorage.removeItem(THEME_STORAGE_KEY);
      else localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Storage blocked (private mode, embedded): the choice lasts this page.
    }
    setTheme(next);
  }

  const label = theme === null ? 'Change color theme' : `Color theme: ${NAMES[theme]} (change)`;
  return (
    <button type="button" className="icon-btn theme-toggle needs-js" onClick={cycle} aria-label={label} title={label}>
      <svg className="theme-icon theme-icon--system" viewBox="0 0 24 24" aria-hidden="true">
        <rect x="3" y="4" width="18" height="12" rx="2" />
        <path d="M8 20h8M12 16v4" />
      </svg>
      <svg className="theme-icon theme-icon--light" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
      </svg>
      <svg className="theme-icon theme-icon--dark" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" />
      </svg>
    </button>
  );
}
