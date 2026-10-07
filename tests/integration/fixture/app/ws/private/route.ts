import type { GioSocket } from '../../../../../../packages/giojs-core/src/public.ts';
import { sessions } from '../../../lib/session.server.ts';

// Authenticated sockets: the session cookie the upgrade request carried
// decides. Async on purpose - messages sent before it settles must be held,
// not lost.
export async function wsHandler(socket: GioSocket): Promise<boolean> {
  await new Promise((resolve) => setTimeout(resolve, 50));
  const userId = sessions.getSession(socket).get('userId');
  if (userId === undefined) return false;
  socket.send(`welcome ${userId}`);
  socket.on('message', (data) => socket.send(`echo:${String(data)}`));
  return true;
}
