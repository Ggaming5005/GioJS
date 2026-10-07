import type { GioSocket } from '@gio.js/core';

export function wsHandler(socket: GioSocket): void {
  socket.on('message', (data) => {
    socket.send(`echo: ${data}`);
  });
}
