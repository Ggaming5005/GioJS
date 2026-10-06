/**
 * tests/integration/fixture/app/node-env/page.tsx
 *
 * Echoes the worker's NODE_ENV. Rust sets it explicitly on the worker it
 * spawns, so this proves both halves run in the mode Rust decided - even
 * when the server itself was started without NODE_ENV.
 */
import React from 'react';

export default function NodeEnv(): React.JSX.Element {
  return <p>{`WORKER_NODE_ENV=${process.env.NODE_ENV ?? 'unset'}`}</p>;
}
