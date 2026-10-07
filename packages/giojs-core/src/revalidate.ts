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
 * `tags` returned from getServerSideProps), shared with ssr.ts - limits
 * mirror giojs-server/src/revalidate.rs - and of `export const revalidate`,
 * at render (ssr.ts) and at route discovery (router.ts).
 */
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { logger } from './logger.ts';

export const MAX_CACHE_TAGS = 64;
export const MAX_CACHE_TAG_BYTES = 256;
const MAX_PATH_BYTES = 2048;
/** Tags under `_gio:` are the server's own (the implicit per-path tag). */
const RESERVED_TAG_PREFIX = '_gio:';
/**
 * How long a call waits for Rust to confirm the purge (or for the server
 * connection, while the worker is between connections, or for its turn
 * behind earlier calls).
 */
export const REVALIDATE_TIMEOUT_MS = 5_000;
/**
 * Frames sent and not yet acked, per worker process. Rust queues a worker's
 * purges in 64 slots (REVALIDATE_QUEUE in giojs-server/src/ipc.rs) and
 * refuses the overflow, so `Promise.all(ids.map(id => revalidateTag(...)))`
 * must not send them all at once: the rest wait here for their turn. Well
 * under 64, leaving room for frames a previous connection left queued.
 */
export const MAX_REVALIDATIONS_IN_FLIGHT = 16;

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
  /** Calls holding one of the MAX_REVALIDATIONS_IN_FLIGHT slots. */
  inFlight: number;
  /** Calls waiting for a slot, oldest first (Sets iterate in insertion order). */
  slotWaiters: Set<() => void>;
  /**
   * Unique to this process. Rust's ack for a frame a crashed worker sent can
   * reach its respawned successor; with ids restarting at 1 there, it would
   * settle an unrelated call of the new worker as purged.
   */
  idPrefix: string;
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
      inFlight: 0,
      slotWaiters: new Set(),
      idPrefix: `rv-${randomUUID()}`,
      nextId: 0,
      warnedOutsideServer: false,
    };
    holder[BRIDGE_KEY] = existing;
  }
  return existing;
}

// C0/C1 control characters - what Rust's char::is_control rejects.
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;
// A UTF-16 surrogate without its pair - e.g. an emoji cut in half by
// `title.slice(0, 20)`. JSON.stringify writes it as a `\ud83d` escape that
// no JSON parser on the Rust side accepts, so the whole frame carrying it
// (a page render, a revalidate call) would be lost.
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/** Why `tag` cannot be a cache tag, or null when it can. */
function tagProblem(tag: unknown): string | null {
  if (typeof tag !== 'string') return 'tags must be strings';
  if (tag === '') return 'tags must not be empty';
  if (Buffer.byteLength(tag, 'utf8') > MAX_CACHE_TAG_BYTES) {
    return `tags are at most ${MAX_CACHE_TAG_BYTES} bytes`;
  }
  if (CONTROL_CHARS.test(tag)) return 'tags must not contain control characters';
  if (LONE_SURROGATE.test(tag)) return 'tags must be well-formed Unicode (no unpaired surrogate)';
  if (tag.startsWith(RESERVED_TAG_PREFIX)) return `tags must not start with "${RESERVED_TAG_PREFIX}"`;
  return null;
}

const UNRESERVED = /^[A-Za-z0-9\-._~]$/;

/** Decode the escapes of RFC 3986 unreserved characters, as Rust does. */
function decodeUnreserved(segment: string): string {
  return segment.replace(/%([0-9A-Fa-f]{2})/g, (escape, hex: string) => {
    const char = String.fromCharCode(parseInt(hex, 16));
    return UNRESERVED.test(char) ? char : escape;
  });
}

/**
 * Why `path` (query and fragment already dropped) is not a path a page can
 * be cached under, or null when it is. Mirrors the server's checks
 * (giojs-server/src/revalidate.rs and path_hygiene.rs), so a bad path is a
 * TypeError here instead of an `ok: false` from the server. Only a
 * `/<locale>/_gio/...` path is left for the server, which knows the locales.
 */
function pathProblem(path: string): string | null {
  if (!path.startsWith('/')) return 'expected a URL path starting with "/"';
  if (Buffer.byteLength(path, 'utf8') > MAX_PATH_BYTES) return `paths are at most ${MAX_PATH_BYTES} bytes`;
  if (CONTROL_CHARS.test(path)) return 'paths must not contain control characters';
  if (LONE_SURROGATE.test(path)) return 'paths must be well-formed Unicode (no unpaired surrogate)';
  if (/%(?![0-9A-Fa-f]{2})/.test(path)) {
    return 'a "%" must start an escape like %20 (write a literal "%" as %25)';
  }
  const segments = path.split('/').map(decodeUnreserved);
  if (segments.some(segment => segment === '.' || segment === '..')) {
    return 'paths must not contain "." or ".." segments';
  }
  if (segments.find(segment => segment !== '') === '_gio') {
    return 'paths under /_gio are the server\'s own and never cached';
  }
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
 * is the URL path the page is served at, decoded (`/blog/café`, as a CMS
 * stores a slug) or percent-encoded (`/blog/caf%C3%A9`, as a browser sends
 * it) - both purge the same page; a `%` always starts an escape. A query or
 * fragment is ignored, and a leading locale segment is dropped, so all
 * locales are purged - which makes a bare `/<locale>` prefix purge every
 * page of the site. Same resolution and per-instance rules as
 * revalidateTag(); throws a TypeError for an invalid path.
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
  const problem = typeof path === 'string' ? pathProblem(bare) : 'paths must be strings';
  if (problem !== null) {
    return Promise.reject(new TypeError(`revalidatePath(${JSON.stringify(path)}): ${problem}`));
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
  if (!(await acquireSlot(state, REVALIDATE_TIMEOUT_MS))) {
    return unconfirmed(targets, 'timed out behind earlier revalidations');
  }
  try {
    return await sendInSlot(state, targets, deadline);
  } finally {
    releaseSlot(state);
  }
}

async function sendInSlot(
  state: RevalidationBridge,
  targets: Pick<RevalidateFrame, 'tags' | 'paths' | 'prefix'>,
  deadline: number,
): Promise<RevalidateResult> {
  const send = state.send ?? (await waitForConnection(state, Math.max(0, deadline - Date.now())));
  if (send === null) {
    return unconfirmed(targets, 'no connection to the server');
  }
  state.nextId += 1;
  const id = `${state.idPrefix}-${state.nextId}`;
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

/**
 * Take one of the MAX_REVALIDATIONS_IN_FLIGHT slots, waiting in line behind
 * earlier calls for at most `timeoutMs`. Resolves false when the wait timed
 * out - the call then never sends its frame.
 */
function acquireSlot(state: RevalidationBridge, timeoutMs: number): Promise<boolean> {
  if (state.inFlight < MAX_REVALIDATIONS_IN_FLIGHT && state.slotWaiters.size === 0) {
    state.inFlight += 1;
    return Promise.resolve(true);
  }
  return new Promise(resolve => {
    const onSlot = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      state.slotWaiters.delete(onSlot);
      resolve(false);
    }, timeoutMs);
    state.slotWaiters.add(onSlot);
  });
}

/** Hand the slot to the longest-waiting call, or free it. */
function releaseSlot(state: RevalidationBridge): void {
  const next = state.slotWaiters.values().next();
  if (next.done === true) {
    state.inFlight -= 1;
    return;
  }
  state.slotWaiters.delete(next.value);
  next.value();
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

/**
 * `export const revalidate` must be a whole number of seconds (0 or more)
 * or `false`. Anything else (`-5`, `1.5`, `'60'`, `NaN`) used to reach Rust
 * as the cache lifetime, which failed to parse the response: a bare 500 on
 * every request with no hint. Checked when the page module is used - page
 * modules load on first request, not at boot - so the failure is an
 * ordinary render error naming the file: the dev overlay in development, a
 * logged error and a 500 with a digest in production. A literal value is
 * checked at discovery too (assertStaticRevalidate).
 */
export function assertValidRevalidate(value: unknown, file: string): void {
  if (value === undefined || value === false) return;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return;
  const got = typeof value === 'string' ? JSON.stringify(value) : typeof value === 'number' ? String(value) : typeof value;
  throw new Error(
    `${file}: export const revalidate must be a whole number of seconds (0 or more) or false - got ${got}`,
  );
}

/** `export const revalidate = <value>` at the start of a line. */
const REVALIDATE_EXPORT =
  /^[ \t]*export\s+const\s+revalidate\s*(?::[^=\n]*)?=\s*([^;\n]*?)\s*(?:;|\/\/|\/\*|$)/m;

/** What `text` is as a literal, or NOT_A_LITERAL for an expression. */
const NOT_A_LITERAL = Symbol('not a literal');

function revalidateLiteral(text: string): unknown {
  if (/^-?\s*(?:\d[\d_]*)?(?:\.\d[\d_]*)?(?:e[+-]?\d+)?$/i.test(text) && /\d/.test(text)) {
    return Number(text.replace(/[\s_]/g, ''));
  }
  const words: Record<string, unknown> = {
    NaN: Number.NaN,
    Infinity: Number.POSITIVE_INFINITY,
    '-Infinity': Number.NEGATIVE_INFINITY,
    true: true,
    false: false,
  };
  if (Object.hasOwn(words, text)) return words[text];
  if (/^'[^'\\]*'$|^"[^"\\]*"$/.test(text)) return text.slice(1, -1);
  return NOT_A_LITERAL;
}

/**
 * The page's `export const revalidate`, read from its `source` at route
 * discovery: a literal the server cannot use (`-5`, `1.5`, `'60'`, `NaN`)
 * stops boot - and `gio build standalone` - naming the file, instead of
 * failing every request to the page. Page modules load on first use, so
 * only a literal is read here; any other expression (`60 * 60`, an
 * imported constant) is checked when the page renders.
 */
export function assertStaticRevalidate(source: string, file: string): void {
  const value = revalidateLiteral(REVALIDATE_EXPORT.exec(source)?.[1] ?? '');
  if (value !== NOT_A_LITERAL) assertValidRevalidate(value, file);
}
