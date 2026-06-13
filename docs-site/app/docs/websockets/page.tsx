import React from 'react';
import { CodeBlock } from '../../../components/CodeBlock.tsx';

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <div className="docs-eyebrow">Building Your App</div>
      <h1>WebSockets</h1>
      <p className="page-subtitle">Full-duplex connections over a dedicated IPC pipe.</p>
      <p>Export a wsHandler from a route.ts to accept WebSocket connections at that path. WebSocket and HTTP IPC are independent, so neither blocks the other.</p>
      <CodeBlock lang="ts" code={`export function wsHandler(socket) {
  socket.on('message', (msg) => socket.send('echo: ' + msg));
}`} />
      <h2>Connection registry</h2>
      <p>The registry exposes send, broadcast, close, and on() hooks for managing many connections.</p>
    </>
  );
}
