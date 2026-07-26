/**
 * giojs-core/src/index.ts
 *
 * Executable entrypoint (package.json "main"). All bootstrap logic lives in
 * main.ts; this file only starts the server.
 */
import { runServer } from './main.ts';

await runServer();
