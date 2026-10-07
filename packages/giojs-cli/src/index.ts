#!/usr/bin/env node
import { create } from './create.js';

const USAGE = `Usage:
  npm create giojs@latest [name] -- [options]   Scaffold a new GioJS app
  npm create giojs@latest -- migrate [dir]      Migrate a Next.js app (see migrate --help)

Options:
  --ts / --js          language
  --server / --static  build target
  --no-install         skip dependency install
  -y, --yes            accept defaults`;

async function main(argv: string[]): Promise<void> {
  if (argv[0] === 'migrate') {
    // Loaded on demand: the migration pulls in the TypeScript compiler,
    // which scaffolding never needs.
    const { runMigrate } = await import('./migrate-command.js');
    process.exitCode = await runMigrate(argv.slice(1));
    return;
  }
  if (argv[0] === '--help' || argv[0] === '-h') {
    console.log(USAGE);
    return;
  }
  await create(argv);
}

main(process.argv.slice(2)).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
