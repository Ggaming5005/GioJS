import { broadcast, type GioRequest } from '../../../../../../../packages/giojs-core/src/public.ts';

// Server-side publish: an HTTP request fans a message out to a WebSocket room.
export function POST(req: GioRequest): { delivered: boolean } {
  const room = req.params['room'] ?? '';
  return { delivered: broadcast(room, `server:${req.body ?? ''}`) };
}
