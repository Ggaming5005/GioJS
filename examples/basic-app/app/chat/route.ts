import type { GioSocket } from '../../../packages/giojs-core/src/context.ts';

export function wsHandler(socket: GioSocket): void {
  socket.on('message', (data) => {
    socket.send(`echo: ${data}`);
  });
}
