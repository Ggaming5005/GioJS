import React from 'react';
import { CodeBlock } from '../../../components/CodeBlock.tsx';

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <div className="docs-eyebrow">Building Your App</div>
      <h1>Route Handlers</h1>
      <p className="page-subtitle">Server endpoints and Server-Sent Events with route.ts files.</p>
      <p>A route.ts (or route.js) file defines a server endpoint at its folder path. Export a GET handler that returns a streaming event source for SSE.</p>
      <CodeBlock lang="ts" code={`export function GET(req) {
  return new GioEventStream((send) => {
    const t = setInterval(() => send({ data: 'tick' }), 1000);
    return () => clearInterval(t);
  });
}`} />
    </>
  );
}
