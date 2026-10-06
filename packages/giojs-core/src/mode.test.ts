/**
 * giojs-core/src/mode.test.ts
 *
 * The worker's dev/production rule must match Rust's (dev iff
 * NODE_ENV=development) so the two halves never run in different modes.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createErrorDigest, describeError, isDevMode } from './mode.ts';

describe('isDevMode', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('is true only for NODE_ENV=development', () => {
    vi.stubEnv('NODE_ENV', 'development');
    expect(isDevMode()).toBe(true);
  });

  it('treats production, test, other values, and unset as production', () => {
    for (const value of ['production', 'test', 'staging', 'Development', '']) {
      vi.stubEnv('NODE_ENV', value);
      expect(isDevMode()).toBe(false);
    }
    vi.stubEnv('NODE_ENV', undefined);
    expect(isDevMode()).toBe(false);
  });
});

describe('createErrorDigest', () => {
  it('returns short, distinct hex references', () => {
    const digests = new Set(Array.from({ length: 50 }, () => createErrorDigest()));
    expect(digests.size).toBe(50);
    for (const digest of digests) expect(digest).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe('describeError', () => {
  it('keeps message and stack of Errors and stringifies anything else', () => {
    const described = describeError(new Error('boom'));
    expect(described.error).toBe('boom');
    expect(described.stack).toContain('boom');
    expect(describeError('plain')).toEqual({ error: 'plain' });
  });
});
