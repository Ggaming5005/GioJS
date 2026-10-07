#!/usr/bin/env node
import { readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { parseArgs, UsageError, USAGE } from './args.js';
import { create } from './create.js';
import { CancelledError } from './select.js';

function version(): string {
  // dist/index.js -> the package's own package.json
  const pkgPath = join(fileURLToPath(import.meta.url), '..', '..', 'package.json');
  return (JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string }).version;
}

async function main(argv: string[]): Promise<void> {
  if (argv[0] === 'migrate') {
    // Loaded on demand: the migration pulls in the TypeScript compiler,
    // which scaffolding never needs.
    const { runMigrate } = await import('./migrate-command.js');
    process.exitCode = await runMigrate(argv.slice(1));
    return;
  }
  const args = parseArgs(argv);
  if (args.help) {
    console.log(USAGE);
    return;
  }
  if (args.version) {
    console.log(version());
    return;
  }
  await create(args);
}

main(process.argv.slice(2)).catch((err: unknown) => {
  if (err instanceof CancelledError) {
    // Every question comes before the first write: nothing to clean up.
    console.error('\nCancelled - nothing was written.');
    process.exit(130);
  }
  if (err instanceof UsageError) {
    console.error(`Error: ${err.message}`);
    process.exit(2);
  }
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
