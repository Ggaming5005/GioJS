/**
 * giojs-core/src/server-only.test.ts
 *
 * `@gio.js/core/server-only` must resolve through the package exports map
 * and be a no-op on the server: importing it from getServerSideProps code
 * can never break SSR.
 */
import { describe, expect, it } from 'vitest';

describe('@gio.js/core/server-only', () => {
  it('resolves through the exports map and exports nothing', async () => {
    const mod: Record<string, unknown> = await import('@gio.js/core/server-only');
    expect(Object.keys(mod).filter(key => key !== 'default')).toEqual([]);
  });
});
