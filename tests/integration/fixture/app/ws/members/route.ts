import type { GioSocket } from '../../../../../../packages/giojs-core/src/public.ts';

// A members-only feed. The publisher (?role=pub) relays what it sends to
// everyone on the path (socket.broadcast) and is in the 'members-feed' room.
// Anyone else joins that room too, then is refused after a slow check: until
// its handler accepts, no route or room broadcast may reach it.
export async function wsHandler(socket: GioSocket): Promise<boolean> {
  socket.join('members-feed');
  if (socket.query['role'] === 'pub') {
    socket.on('message', (data) => socket.broadcast(String(data)));
    socket.send('ready');
    return true;
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
  return false;
}
