import type { GioSocket } from '../../../../../../packages/giojs-core/src/public.ts';

// First-message authentication: browsers cannot set headers on a WebSocket,
// so the client sends its token as the first message and the async handler
// awaits it before deciding.
export async function wsHandler(socket: GioSocket): Promise<boolean> {
  const token = await new Promise<string>((resolve) => {
    socket.on('message', (data) => resolve(String(data)));
  });
  if (token !== 'let-me-in') return false;
  socket.send('welcome');
  return true;
}
