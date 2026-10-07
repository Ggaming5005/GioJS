/**
 * docs-site/components/DocsSearch.tsx
 *
 * Docs search: the header button and the dialog it opens. Opens on the
 * button, on Ctrl+K / Cmd+K and on `/` (outside text fields), and on any
 * element marked `data-docs-search` (the search box on /docs).
 *
 * The layout ships in every route bundle, so nothing heavy is loaded up
 * front: the first open (or hovering the button) fetches /search-index.json
 * and imports the engine (lib/search.mjs) as a separate chunk; both are
 * kept for the rest of the visit.
 *
 * Keyboard: ↑/↓ move through the results, Enter opens one, Esc closes.
 * The input is an ARIA combobox over a grouped listbox, and focus returns
 * to where it was when the dialog closes.
 */
import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Searcher, SearchResult, TextPart } from '../lib/search.mjs';

let loading: Promise<Searcher> | null = null;

/** The engine and the index, loaded once; a failed load is retried on the next open. */
function loadSearcher(): Promise<Searcher> {
  loading ??= Promise.all([
    import('../lib/search.mjs'),
    fetch('/search-index.json').then((response) => {
      if (!response.ok) throw new Error(`search index: HTTP ${response.status}`);
      return response.json();
    }),
  ]).then(([engine, index]) => engine.createSearch(index));
  loading.catch(() => {
    loading = null;
  });
  return loading;
}

const SUGGESTIONS = ['redirect', 'getServerSideProps', 'revalidate', 'gio.toml', 'useRouter', 'csrf'];

function Highlighted({ parts }: { parts: TextPart[] }): React.JSX.Element {
  return (
    <>
      {parts.map((part, i) => (part.hit ? <mark key={i}>{part.text}</mark> : <React.Fragment key={i}>{part.text}</React.Fragment>))}
    </>
  );
}

/** Whether a key press is typing into something (where `/` must stay a slash). */
function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);
}

export function DocsSearch(): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [searcher, setSearcher] = useState<Searcher | null>(null);
  const [failed, setFailed] = useState(false);
  const [active, setActive] = useState(0);
  const [shortcut, setShortcut] = useState('Ctrl K');
  const inputRef = useRef<HTMLInputElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const id = useId();
  const listId = `${id}-results`;
  const optionId = (index: number): string => `${id}-option-${index}`;

  const preload = useCallback(() => {
    loadSearcher().then(setSearcher, () => setFailed(true));
  }, []);

  const show = useCallback(() => {
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setFailed(false);
    setOpen(true);
    preload();
  }, [preload]);

  const hide = useCallback(() => {
    setOpen(false);
    returnFocus.current?.focus();
  }, []);

  // The platform's shortcut name is only known in the browser.
  useEffect(() => {
    if (/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)) setShortcut('⌘K');
  }, []);

  // Global shortcuts, and the `data-docs-search` openers anywhere on the page.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key.toLowerCase() === 'k' && (event.metaKey || event.ctrlKey) && !event.altKey) {
        event.preventDefault();
        if (open) hide();
        else show();
      } else if (event.key === '/' && !open && !event.metaKey && !event.ctrlKey && !event.altKey && !isTyping(event.target)) {
        event.preventDefault();
        show();
      }
    };
    const onClick = (event: MouseEvent): void => {
      const opener = event.target instanceof Element ? event.target.closest('[data-docs-search]') : null;
      if (opener !== null) {
        event.preventDefault();
        show();
      }
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('click', onClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('click', onClick);
    };
  }, [open, show, hide]);

  // While open: focus the input, keep the page behind it still.
  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    inputRef.current?.select();
    document.body.classList.add('search-open');
    return () => document.body.classList.remove('search-open');
  }, [open]);

  // Synchronous on purpose: a query takes about a millisecond, and Enter
  // must never open a result of the previous keystroke.
  const result: SearchResult | null = useMemo(
    () => (searcher !== null && query.trim() !== '' ? searcher.search(query) : null),
    [searcher, query],
  );
  const options = useMemo(
    () => (result?.pages ?? []).flatMap((page) => page.items.map((item) => ({ page, item }))),
    [result],
  );

  useEffect(() => setActive(0), [result]);
  useEffect(() => {
    if (open) document.getElementById(`${id}-option-${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [id, active, open]);

  function go(url: string): void {
    setOpen(false);
    window.location.assign(url);
  }

  function onInputKey(event: React.KeyboardEvent<HTMLInputElement>): void {
    const count = options.length;
    if (event.key === 'ArrowDown' && count > 0) {
      event.preventDefault();
      setActive((current) => (current + 1) % count);
    } else if (event.key === 'ArrowUp' && count > 0) {
      event.preventDefault();
      setActive((current) => (current - 1 + count) % count);
    } else if (event.key === 'Home' && count > 0 && event.ctrlKey) {
      event.preventDefault();
      setActive(0);
    } else if (event.key === 'End' && count > 0 && event.ctrlKey) {
      event.preventDefault();
      setActive(count - 1);
    } else if (event.key === 'Enter') {
      const chosen = options[active];
      if (chosen !== undefined) {
        event.preventDefault();
        if (event.metaKey || event.ctrlKey) window.open(chosen.item.url, '_blank', 'noopener');
        else go(chosen.item.url);
      }
    }
  }

  // Esc closes from anywhere in the dialog; Tab cycles within it.
  function onDialogKey(event: React.KeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      hide();
    } else if (event.key === 'Tab') {
      const focusable = [...event.currentTarget.querySelectorAll<HTMLElement>('input, button')];
      const at = focusable.indexOf(document.activeElement as HTMLElement);
      const next = focusable[(at + (event.shiftKey ? -1 : 1) + focusable.length) % focusable.length];
      event.preventDefault();
      next?.focus();
    }
  }

  let status: React.ReactNode = null;
  if (failed) status = 'The search index could not be loaded. Check your connection and try again.';
  else if (query.trim() !== '' && searcher === null) status = 'Loading the search index…';
  else if (result !== null && options.length === 0) status = <>No results for “{query.trim()}”.</>;

  let index = -1;
  return (
    <>
      <button
        type="button"
        className="search-btn needs-js"
        onClick={show}
        onPointerEnter={preload}
        onFocus={preload}
        aria-label="Search documentation"
        aria-haspopup="dialog"
      >
        <svg className="search-btn__icon" viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
        <span className="search-btn__text">Search docs…</span>
        <kbd className="search-btn__kbd">{shortcut}</kbd>
      </button>

      {open && createPortal(
        <div
          className="search-overlay"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) hide();
          }}
        >
          <div className="search-dialog" role="dialog" aria-modal="true" aria-label="Search documentation" onKeyDown={onDialogKey}>
            <div className="search-field">
              <svg className="search-field__icon" viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="11" cy="11" r="7" />
                <path d="m20 20-3.5-3.5" />
              </svg>
              <input
                ref={inputRef}
                className="search-input"
                type="search"
                role="combobox"
                aria-expanded={options.length > 0}
                aria-controls={listId}
                aria-autocomplete="list"
                aria-activedescendant={options.length > 0 ? optionId(active) : undefined}
                placeholder="Search pages, APIs, gio.toml keys…"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={onInputKey}
              />
              <button type="button" className="search-close" onClick={hide} aria-label="Close search">
                Esc
              </button>
            </div>

            <div className="search-body">
              {status !== null && <p className="search-status" role="status">{status}</p>}
              {query.trim() === '' && !failed && (
                <div className="search-empty">
                  <p>Search every page, section, API name and gio.toml key. Try:</p>
                  <ul>
                    {SUGGESTIONS.map((suggestion) => (
                      <li key={suggestion}>
                        <button type="button" onClick={() => { setQuery(suggestion); inputRef.current?.focus(); }}>
                          {suggestion}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <div id={listId} role="listbox" aria-label="Search results" className="search-results">
                {result?.pages.map((page) => (
                  <div role="group" aria-label={page.title} key={page.url} className="search-group">
                    <div className="search-group__head" aria-hidden="true">
                      <span className="search-group__title"><Highlighted parts={page.titleParts} /></span>
                      <span className="search-group__crumb">
                        {page.group !== undefined ? `${page.section} › ${page.group}` : page.section}
                      </span>
                    </div>
                    {page.items.map((item) => {
                      index += 1;
                      const mine = index;
                      return (
                        <a
                          key={item.url}
                          id={optionId(mine)}
                          href={item.url}
                          role="option"
                          aria-selected={mine === active}
                          tabIndex={-1}
                          className={item.heading === '' ? 'search-option search-option--page' : 'search-option'}
                          onMouseMove={() => {
                            if (mine !== active) setActive(mine);
                          }}
                          onClick={() => setOpen(false)}
                        >
                          <span className="search-option__title">
                            {item.heading === '' ? <Highlighted parts={page.titleParts} /> : <Highlighted parts={item.headingParts} />}
                          </span>
                          {item.snippet.some((part) => part.text !== '') && (
                            <span className="search-option__snippet"><Highlighted parts={item.snippet} /></span>
                          )}
                        </a>
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>

            <div className="search-footer" aria-hidden="true">
              <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
              <span><kbd>↵</kbd> open</span>
              <span><kbd>esc</kbd> close</span>
              {result !== null && result.total > 0 && (
                <span className="search-footer__count">
                  {result.total} {result.total === 1 ? 'page' : 'pages'}
                </span>
              )}
            </div>
            <p className="sr-only" aria-live="polite">
              {result === null ? '' : `${result.total} ${result.total === 1 ? 'page' : 'pages'} found`}
            </p>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
