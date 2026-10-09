import { broadcast, type GioSocket } from '../../../../../../../packages/giojs-core/src/public.ts';

// A dynamic WebSocket route: the socket joins the room named by [room],
// greets with the connection context it was given, and relays every
// message to its room only.
export function wsHandler(socket: GioSocket): boolean | void {
  if (socket.query['deny'] === '1') return false;
  const room = socket.params['room'] ?? '';
  socket.join(room);
  socket.send(
    JSON.stringify({
      type: 'hello',
      path: socket.path,
      params: socket.params,
      query: socket.query,
      cookies: socket.cookies,
      userAgent: socket.headers['user-agent'] ?? null,
      forwardedFor: socket.headers['x-forwarded-for'] ?? null,
      ip: socket.ip ?? null,
      requestId: socket.requestId ?? null,
      rooms: [...socket.rooms],
    }),
  );
  socket.on('message', (data) => {
    broadcast(room, `${room}:${String(data)}`);
  });
}
