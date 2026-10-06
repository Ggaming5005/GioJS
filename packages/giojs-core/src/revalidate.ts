/**
 * giojs-core/src/revalidate.ts
 *
 * On-demand revalidation from server code: revalidateTag() and
 * revalidatePath() purge pages from the Rust server's cache, so the next
 * request for each is a miss and renders fresh. The worker sends a
 * `revalidate` frame over the IPC connection and the call resolves when
 * Rust acks it - `await revalidateTag('posts')` returning means the purge
 * happened (or `ok: false` says why it could not be confirmed).
 *
 * Also the validation of the tags pages declare (`export const tags`, and
 * `tags` returned from getServerSideProps), shared with ssr.ts. Limits
 * mirror giojs-server/src/revalidate.rs.
 */
import { Buffer } from 'node:buffer';
import { logger } from './logger.ts';

export const MAX_CACHE_TAGS = 64;
export const MAX_CACHE_TAG_BYTES = 256;
const MAX_PATH_BYTES = 2048;
/** Tags under `_gio:` are the server's own (the implicit per-path tag). */
const RESERVED_TAG_PREFIX = '_gio:';
/**
 * How long a call waits for Rust to confirm the purge (or for the server
 * connection, while the worker is between connections).
 */
export const REVALIDATE_TIMEOUT_MS = 5_000;

/** What a revalidateTag / revalidatePath call achieved. */
export interface RevalidateResult {
  /** True once the server confirmed the purge. */
  ok: boolean;
  /** Cache entries purged (each query-string and locale variant counts). */
  purged: number;
  /** Why the purge was not confirmed (`ok: false`). */
  error?: string;
}

export interface RevalidatePathOptions {
  /**
   * 'page' (default): only the page at exactly this path, every query
   * string and locale of it. 'prefix': the path and everything below it,
   * at segment boundaries (`/blog` covers `/blog/a`, not `/blogger`).
   */
  type?: 'page' | 'prefix';
}

/** Worker → Rust. The fields mirror the POST /_gio/revalidate body. */
export interface RevalidateFrame {
  type: 'revalidate';
  id: string;
  tags: string[];
  paths: string[];
  prefix: boolean;
}

/** Rust → worker, answering a RevalidateFrame by id. */
export interface RevalidateAckMsg {
  type: 'revalidate_ack';
  id: string;
  ok: boolean;
  purged: number;
  error?: string;
}

interface RevalidationBridge {
  /** createIPCServer ran: this process is a worker behind the Rust server. */
  server: boolean;
  /** Writes a frame to the live server connection; null between connections. */
  send: ((frame: RevalidateFrame) => void) | null;
  pending: Map<string, (result: RevalidateResult) => void>;
  /** Calls waiting for a server connection. */
  connectWaiters: Set<() => void>;
  nextId: number;
  warnedOutsideServer: boolean;
}

// Shared through globalThis, not module state: app modules load in their
// own tsx namespace (see not-found.ts), so the copy of this module a route
// handler imports is not the one the IPC server wired up.
const BRIDGE_KEY = Symbol.for('gio.revalidate');

function bridge(): RevalidationBridge {
  const holder = globalThis as unknown as Record<symbol, RevalidationBridge | undefined>;
  let existing = holder[BRIDGE_KEY];
  if (existing === undefined) {
    existing = {
      server: false,
      send: null,
      pending: new Map(),
      connectWaiters: new Set(),
      nextId: 0,
      warnedOutsideServer: false,
    };
    holder[BRIDGE_KEY] = existing;
  }
  return existing;
}

// C0/C1 control characters - what Rust's char::is_control rejects.
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

/** Why `tag` cannot be a cache tag, or null when it can. */
function tagProblem(tag: unknown): string | null {
  if (typeof tag !== 'string') return 'tags must be strings';
  if (tag === '') return 'tags must not be empty';
  if (Buffer.byteLength(tag, 'utf8') > MAX_CACHE_TAG_BYTES) {
    return `tags are at most ${MAX_CACHE_TAG_BYTES} bytes`;
  }
  if (CONTROL_CHARS.test(tag)) return 'tags must not contain control characters';
  if (tag.startsWith(RESERVED_TAG_PREFIX)) return `tags must not start with "${RESERVED_TAG_PREFIX}"`;
  return null;
}

const warnedTagProblems = new Set<string>();

/**
 * Tag problems are reported once per route and problem: a page renders
 * thousands of times, and the log must not repeat the same hint each time.
 */
function warnTagProblemOnce(route: string, problem: string, fields: Record<string, unknown>): void {
  const key = `${route}\0${problem}`;
  if (warnedTagProblems.has(key) || warnedTagProblems.size >= 1_000) return;
  warnedTagProblems.add(key);
  logger.warn(`cache tags ignored: ${problem}`, { route, ...fields });
}

/**
 * The valid, de-duplicated tags of a page render (at most MAX_CACHE_TAGS)
 * from its declarations: `export const tags` and getServerSideProps'
 * `tags`. Invalid entries are dropped with a warning rather than failing the
 * render over a cache hint.
 */
export function sanitizeCacheTags(
  declarations: ReadonlyArray<{ source: string; value: unknown }>,
  route: string,
): string[] {
  const tags: string[] = [];
  for (const { source, value } of declarations) {
    if (value === undefined) continue;
    if (!Array.isArray(value)) {
      warnTagProblemOnce(route, `${source} must be an array of strings`, {});
      continue;
    }
    for (const tag of value as unknown[]) {
      const problem = tagProblem(tag);
      if (problem !== null) {
        warnTagProblemOnce(route, `${source}: ${problem}`, {
          tag: typeof tag === 'string' ? tag.slice(0, 64) : typeof tag,
        });
        continue;
      }
      const valid = tag as string;
      if (tags.includes(valid)) continue;
      if (tags.length === MAX_CACHE_TAGS) {
        warnTagProblemOnce(route, `more than ${MAX_CACHE_TAGS} tags - the rest are dropped`, {});
        return tags;
      }
      tags.push(valid);
    }
  }
  return tags;
}

/**
 * Purge every cached page carrying `tag` - declared with
 * `export const tags = [...]` or returned as `{ props, tags }` from
 * getServerSideProps. The next request for each is a miss and renders
 * fresh. Resolves once the server confirmed the purge; on a timeout or a
 * lost connection it resolves with `ok: false` (and logs a warning) rather
 * than throwing, so a mutation that already succeeded is not failed over
 * its cache refresh. Throws a TypeError for an invalid tag.
 *
 * The cache belongs to the server instance this worker runs behind: with
 * several instances, call POST /_gio/revalidate on each of the others.
 * Outside the GioJS server (`gio export`, unit tests) it does nothing and
 * warns once.
 */
export function revalidateTag(tag: string): Promise<RevalidateResult> {
  const problem = tagProblem(tag);
  if (problem !== null) {
    return Promise.reject(new TypeError(`revalidateTag(${JSON.stringify(tag)}): ${problem}`));
  }
  return sendRevalidation({ tags: [tag], paths: [], prefix: false });
}

/**
 * Purge the cached page at `path` - every query string and locale variant
 * of it - or, with `{ type: 'prefix' }`, everything at and below it. `path`
 * is the URL path the page is served at (a query or fragment is ignored; a
 * leading locale segment is dropped, so all locales are purged). Same
 * resolution and per-instance rules as revalidateTag().
 */
export function revalidatePath(
  path: string,
  options?: RevalidatePathOptions,
): Promise<RevalidateResult> {
  const type = options?.type ?? 'page';
  if (type !== 'page' && type !== 'prefix') {
    return Promise.reject(
      new TypeError(`revalidatePath: type must be 'page' or 'prefix', got ${JSON.stringify(type)}`),
    );
  }
  const bare = typeof path === 'string' ? path.split(/[?#]/, 1)[0] ?? '' : '';
  if (
    !bare.startsWith('/') ||
    Buffer.byteLength(bare, 'utf8') > MAX_PATH_BYTES ||
    CONTROL_CHARS.test(bare)
  ) {
    return Promise.reject(
      new TypeError(
        `revalidatePath(${JSON.stringify(path)}): expected a URL path starting with "/" ` +
          `(at most ${MAX_PATH_BYTES} bytes, no control characters)`,
      ),
    );
  }
  return sendRevalidation({ tags: [], paths: [bare], prefix: type === 'prefix' });
}

async function sendRevalidation(
  targets: Pick<RevalidateFrame, 'tags' | 'paths' | 'prefix'>,
): Promise<RevalidateResult> {
  const state = bridge();
  if (!state.server) {
    if (!state.warnedOutsideServer) {
      state.warnedOutsideServer = true;
      logger.warn(
        'revalidateTag/revalidatePath called outside the GioJS server (gio export, tests) - nothing to purge',
      );
    }
    return { ok: false, purged: 0, error: 'not running behind the GioJS server' };
  }
  const deadline = Date.now() + REVALIDATE_TIMEOUT_MS;
  const send = state.send ?? (await waitForConnection(state, REVALIDATE_TIMEOUT_MS));
  if (send === null) {
    return unconfirmed(targets, 'no connection to the server');
  }
  state.nextId += 1;
  const id = `rv-${state.nextId}`;
  const result = await new Promise<RevalidateResult>(resolve => {
    const timer = setTimeout(
      () => {
        state.pending.delete(id);
        resolve({ ok: false, purged: 0, error: 'timed out waiting for the server' });
      },
      Math.max(0, deadline - Date.now()),
    );
    state.pending.set(id, ack => {
      clearTimeout(timer);
      state.pending.delete(id);
      resolve(ack);
    });
    try {
      send({ type: 'revalidate', id, ...targets });
    } catch (sendError) {
      state.pending.get(id)?.({
        ok: false,
        purged: 0,
        error: sendError instanceof Error ? sendError.message : String(sendError),
      });
    }
  });
  if (!result.ok) {
    return unconfirmed(targets, result.error ?? 'refused by the server');
  }
  return result;
}

function unconfirmed(
  targets: Pick<RevalidateFrame, 'tags' | 'paths' | 'prefix'>,
  error: string,
): RevalidateResult {
  logger.warn('cache revalidation not confirmed', { ...targets, error });
  return { ok: false, purged: 0, error };
}

function waitForConnection(
  state: RevalidationBridge,
  timeoutMs: number,
): Promise<RevalidationBridge['send']> {
  return new Promise(resolve => {
    const onConnect = (): void => {
      clearTimeout(timer);
      state.connectWaiters.delete(onConnect);
      resolve(state.send);
    };
    const timer = setTimeout(() => {
      state.connectWaiters.delete(onConnect);
      resolve(null);
    }, timeoutMs);
    state.connectWaiters.add(onConnect);
  });
}

/** createIPCServer: this process serves the Rust server. */
export function enableRevalidation(): void {
  bridge().server = true;
}

/**
 * The server connection is up (handshake done). Returns the detach function
 * for its close: calls still waiting on that connection resolve `ok: false`
 * - the purge may or may not have happened.
 */
export function attachRevalidationChannel(send: (frame: RevalidateFrame) => void): () => void {
  const state = bridge();
  state.send = send;
  for (const waiter of [...state.connectWaiters]) waiter();
  return () => {
    if (state.send !== send) return;
    state.send = null;
    for (const settle of [...state.pending.values()]) {
      settle({ ok: false, purged: 0, error: 'server connection closed before the purge was confirmed' });
    }
  };
}

/** A `revalidate_ack` frame from Rust. Unknown ids (timed out) are ignored. */
export function settleRevalidateAck(msg: Record<string, unknown>): void {
  if (typeof msg['id'] !== 'string') {
    logger.warn('revalidate_ack frame missing string id');
    return;
  }
  const settle = bridge().pending.get(msg['id']);
  if (settle === undefined) return;
  settle({
    ok: msg['ok'] === true,
    purged: typeof msg['purged'] === 'number' ? msg['purged'] : 0,
    ...(typeof msg['error'] === 'string' ? { error: msg['error'] } : {}),
  });
}
