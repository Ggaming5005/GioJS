/**
 * GioEventStream handlers: a cleanup function, nothing, or a promise of
 * either is a valid handler result; anything else is rejected.
 */
import { GioEventStream, type SseCleanupFn, type SseHandler } from '@gio.js/core';

new GioEventStream(stream => {
  const timer = setInterval(() => stream.send({ time: Date.now() }), 1000);
  return () => clearInterval(timer);
});

// No cleanup at all.
new GioEventStream(stream => {
  stream.send('hello');
  stream.close();
});

// Async: the cleanup is what the promise resolves to.
new GioEventStream(async stream => {
  await Promise.resolve();
  const timer = setInterval(() => stream.send('tick'), 1000);
  return () => clearInterval(timer);
});

new GioEventStream(async stream => {
  await Promise.resolve();
  stream.close();
});

const cleanup: SseCleanupFn = () => undefined;
const handler: SseHandler = async () => cleanup;
new GioEventStream(handler);

// @ts-expect-error - a cleanup must be a function
new GioEventStream(() => 42);

// @ts-expect-error - nor may an async handler resolve to anything else
new GioEventStream(async () => 'done');
