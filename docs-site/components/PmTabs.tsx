/**
 * docs-site/components/PmTabs.tsx
 *
 * A shell command with a tab per package manager (npm, pnpm, yarn, bun).
 * Write the npm form once; the others are derived (lib/package-managers.mjs)
 * unless given:
 *
 *   <PmTabs command="npm install @gio.js/core" />
 *   <PmTabs command="npx gio dev" pnpm="pnpm gio dev" />
 *
 * The reader's pick is remembered (localStorage, best effort) and every
 * PmTabs on the page follows it. The server and the first client render
 * show npm, so hydration matches; the stored pick applies right after.
 * Without JS only npm shows. Search and the Markdown copy read the npm
 * panel alone (the others are data-no-index). Each tab and its panel point
 * at each other (aria-controls / aria-labelledby) through useId ids, which
 * the server and the hydrating client derive alike.
 */
import React, { useEffect, useId, useState } from 'react';
import { highlight } from '../lib/highlight.mjs';
import { PACKAGE_MANAGERS, pmCommands, type PackageManager } from '../lib/package-managers.mjs';
import { CopyButton } from './CopyButton.tsx';

const STORAGE_KEY = 'giojs-docs-pm';
/** Fired on window when the reader picks a manager, so every PmTabs on the page follows. */
const PICK_EVENT = 'giojs-docs-pm';

function isPackageManager(value: unknown): value is PackageManager {
  return typeof value === 'string' && (PACKAGE_MANAGERS as string[]).includes(value);
}

function storedPick(): PackageManager | null {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return isPackageManager(value) ? value : null;
  } catch {
    return null;
  }
}

function pick(pm: PackageManager): void {
  try {
    localStorage.setItem(STORAGE_KEY, pm);
  } catch {
    // Storage blocked: the pick lasts this page.
  }
  window.dispatchEvent(new CustomEvent(PICK_EVENT, { detail: pm }));
}

interface PmTabsProps {
  /** The npm form, one command per line (`cd` and comments pass through). */
  command: string;
  pnpm?: string;
  yarn?: string;
  bun?: string;
}

export function PmTabs({ command, ...overrides }: PmTabsProps): React.JSX.Element {
  const commands = { ...pmCommands(command), ...overrides };
  const [selected, setSelected] = useState<PackageManager>('npm');
  const baseId = useId();
  const tabId = (pm: PackageManager): string => `${baseId}tab-${pm}`;
  const panelId = (pm: PackageManager): string => `${baseId}panel-${pm}`;
  useEffect(() => {
    const stored = storedPick();
    if (stored !== null) setSelected(stored);
    const follow = (event: Event): void => {
      const detail = (event as CustomEvent<unknown>).detail;
      if (isPackageManager(detail)) setSelected(detail);
    };
    window.addEventListener(PICK_EVENT, follow);
    return () => window.removeEventListener(PICK_EVENT, follow);
  }, []);

  /** Arrow keys, Home and End move between the tabs (WAI-ARIA tabs pattern). */
  function onKeyDown(event: React.KeyboardEvent<HTMLButtonElement>): void {
    const at = PACKAGE_MANAGERS.indexOf(selected);
    const last = PACKAGE_MANAGERS.length - 1;
    const to = { ArrowRight: at === last ? 0 : at + 1, ArrowLeft: at === 0 ? last : at - 1, Home: 0, End: last }[
      event.key
    ];
    if (to === undefined) return;
    event.preventDefault();
    const pm = PACKAGE_MANAGERS[to] ?? 'npm';
    pick(pm);
    const tabs = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    tabs?.[to]?.focus();
  }

  return (
    <div className="code-block pm-tabs">
      <div className="code-block-header" data-no-index="">
        <div className="pm-tabs__list" role="tablist" aria-label="Package manager">
          {PACKAGE_MANAGERS.map((pm) => (
            <button
              key={pm}
              type="button"
              role="tab"
              id={tabId(pm)}
              aria-controls={panelId(pm)}
              className={pm === 'npm' ? 'pm-tabs__tab' : 'pm-tabs__tab needs-js'}
              aria-selected={pm === selected}
              tabIndex={pm === selected ? 0 : -1}
              onClick={() => pick(pm)}
              onKeyDown={onKeyDown}
            >
              {pm}
            </button>
          ))}
        </div>
        <CopyButton text={commands[selected]} what="command" />
      </div>
      {PACKAGE_MANAGERS.map((pm) => (
        <pre
          key={pm}
          role="tabpanel"
          id={panelId(pm)}
          aria-labelledby={tabId(pm)}
          data-lang="bash"
          hidden={pm !== selected}
          {...(pm === 'npm' ? {} : { 'data-no-index': '' })}
        >
          <code dangerouslySetInnerHTML={{ __html: highlight(commands[pm], 'bash') }} />
        </pre>
      ))}
    </div>
  );
}
