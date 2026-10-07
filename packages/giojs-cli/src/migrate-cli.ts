#!/usr/bin/env node
/**
 * packages/giojs-cli/src/migrate-cli.ts
 *
 * The standalone `gio-migrate` bin - the same command as
 * `create-giojs migrate` (see migrate-command.ts).
 */
import { runMigrate } from './migrate-command.js';

runMigrate(process.argv.slice(2)).then(
  code => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(`\nError: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);
