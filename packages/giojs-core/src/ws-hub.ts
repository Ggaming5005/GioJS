/**
 * giojs-core/src/ws-hub.ts
 *
 * Server-side room broadcast for app code: `broadcast(room, message)` from a
 * route.ts handler (a POST that publishes to a chat room, a webhook that
 * notifies subscribers) or from a wsHandler. Room membership lives in Rust's
 * WebSocket registry (socket.join / socket.leave), so a broadcast crosses
 * the WS IPC pipe as one frame however many sockets it reaches.
 *
 * Kept free of heavy imports: it is part of the public API surface.
 */
import { Buffer } from 'node:buffer';
import type { WsOutbound, WsRoomBroadcastMsg } from './context.ts';

/** Rooms one socket may be in at once; join() beyond this throws. */
export const MAX_ROOMS_PER_SOCKET = 100;
/** Longest room name, in UTF-8 bytes. */
export const MAX_ROOM_NAME_BYTES = 256;

interface WsHub {
  /** The live WS IPC connection's frame writer; null while none is up. */
  write: ((msg: WsOutbound) => void) | null;
}

// Symbol.for, not module state: route files load in their own tsx module
// namespace, so their copy of this module must find the worker's writer.
const HUB_KEY = Symbol.for('gio.ws.hub');

export function wsHub(): WsHub {
  const scope = globalThis as unknown as Record<symbol, WsHub | undefined>;
  let hub = scope[HUB_KEY];
  if (hub === undefined) {
    hub = { write: null };
    scope[HUB_KEY] = hub;
  }
  return hub;
}

/** Throws for a room name join() and broadcast() must refuse. */
export function assertRoomName(room: unknown): asserts room is string {
  if (typeof room !== 'string' || room === '') {
    throw new TypeError('room must be a non-empty string');
  }
  if (Buffer.byteLength(room, 'utf8') > MAX_ROOM_NAME_BYTES) {
    throw new RangeError(`room name exceeds ${MAX_ROOM_NAME_BYTES} bytes`);
  }
}

export interface BroadcastOptions {
  /** A socket id (`socket.id`) to leave out - typically the sender. */
  except?: string;
}

export function roomBroadcastFrame(
  room: string,
  data: string | Uint8Array,
  options: BroadcastOptions = {},
): WsRoomBroadcastMsg {
  const binary = typeof data !== 'string';
  return {
    type: 'ws_room_broadcast',
    room,
    data: binary ? Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('base64') : data,
    isBinary: binary,
    ...(options.except !== undefined ? { except: options.except } : {}),
  };
}

/**
 * Send `data` to every WebSocket in `room` (see socket.join). Strings go out
 * as text frames, bytes as binary frames. Returns false when no WebSocket
 * server is connected (websockets disabled in gio.toml, static export, or
 * the moment the worker restarts) - the message is then dropped, like one
 * sent to an empty room. Delivery is best-effort: under backpressure from
 * the server, payload frames may be dropped rather than buffered without
 * bound.
 */
export function broadcast(
  room: string,
  data: string | Uint8Array,
  options: BroadcastOptions = {},
): boolean {
  assertRoomName(room);
  const write = wsHub().write;
  if (write === null) return false;
  write(roomBroadcastFrame(room, data, options));
  return true;
}
