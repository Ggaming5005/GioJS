/**
 * Testing-kit fixture: a test process that starts a server and never calls
 * close(). testing.test.ts runs it with `node --import tsx` and checks that
 * nothing of the server outlives it.
 *
 *   forget <appDir>  start, print the port, end - the process must exit on its own
 *   hang <appDir>    start, print the port, stay alive until SIGKILLed (no hook runs)
 *   thread <appDir>  start from a worker thread, terminate the thread (no hook
 *                    runs, as under vitest's threads pool), stay alive
 */
import { Worker } from 'node:worker_threads';
import { createTestServer } from '../src/testing.ts';

const keepAlive = (): void => {
  setInterval(() => undefined, 60_000);
};

const [mode, appDir] = process.argv.slice(2);
if (appDir === undefined) throw new Error('usage: testing-orphans.ts forget|hang|thread <appDir>');

if (mode === 'thread') {
  // tsx's --import hooks do not reach worker threads: the thread loads the
  // kit through tsx's API instead.
  const source = `
import { parentPort, workerData } from 'node:worker_threads';
const { tsImport } = await import(${JSON.stringify(import.meta.resolve('tsx/esm/api'))});
const { createTestServer } = await tsImport(${JSON.stringify(new URL('../src/testing.ts', import.meta.url).href)}, ${JSON.stringify(import.meta.url)});
const server = await createTestServer({ appDir: workerData });
parentPort.postMessage(server.port);
setInterval(() => undefined, 60000);
`;
  const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(source)}`), {
    workerData: appDir,
  });
  const port = await new Promise<number>((resolvePort, reject) => {
    worker.once('message', resolvePort);
    worker.once('error', reject);
  });
  await worker.terminate();
  console.log(`port ${port}`);
  console.log('terminated');
  keepAlive();
} else {
  const server = await createTestServer({ appDir });
  console.log(`port ${server.port}`);
  if (mode === 'hang') keepAlive();
}
