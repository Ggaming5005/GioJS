#!/usr/bin/env node
/**
 * packages/giojs-cli/src/migrate-cli.ts
 *
 * Entry point for the gio-migrate command.
 * Parses CLI flags and delegates to migrate.ts or next-config-converter.ts.
 *
 * Usage:
 *   gio-migrate [directory]            Apply transforms to all source files
 *   gio-migrate --dry-run [directory]  Show what would change, don't write
 *   gio-migrate --config next.config.js  Convert next.config.js → gio.toml
 */
import { resolve } from 'path';
import { migrateDirectory, type TransformResult } from './migrate.js';
import { convertNextConfig } from './next-config-converter.js';

function parseArgs(argv: string[]): {
  dryRun: boolean;
  configFile: string | null;
  directory: string;
} {
  const args = argv.slice(2);
  let dryRun = false;
  let configFile: string | null = null;
  let directory = process.cwd();

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--config') {
      configFile = args[i + 1] ?? null;
      i++;
    } else if (!arg.startsWith('-')) {
      directory = resolve(arg);
    }
  }

  return { dryRun, configFile, directory };
}

function printResults(results: TransformResult[], dryRun: boolean): void {
  let totalFiles = 0;
  let totalTransforms = 0;

  for (const r of results) {
    if (r.changed) {
      totalFiles++;
      totalTransforms += r.count;
      const label = dryRun ? '(dry-run) ' : '';
      console.log(`  ✔ ${label}${r.filePath} — ${r.count} transform${r.count !== 1 ? 's' : ''} (${r.transforms.join(', ')})`);
      if (r.diff) {
        console.log('');
        for (const line of r.diff.split('\n')) {
          if (line.startsWith('+')) {
            process.stdout.write(`\x1b[32m${line}\x1b[0m\n`);
          } else if (line.startsWith('-')) {
            process.stdout.write(`\x1b[31m${line}\x1b[0m\n`);
          } else {
            console.log(line);
          }
        }
        console.log('');
      }
    } else {
      console.log(`    ${r.filePath} — skipped (no Next.js imports found)`);
    }
  }

  console.log('');
  if (dryRun) {
    console.log(`Dry run — no files modified.`);
  }
  console.log(`Total: ${totalFiles} file${totalFiles !== 1 ? 's' : ''} modified, ${totalTransforms} transform${totalTransforms !== 1 ? 's' : ''} applied`);
}

async function main(): Promise<void> {
  const { dryRun, configFile, directory } = parseArgs(process.argv);

  if (configFile !== null) {
    const resolved = resolve(configFile);
    await convertNextConfig(resolved);
    return;
  }

  console.log(`\nGioJS migration${dryRun ? ' (dry run)' : ''}: ${directory}\n`);
  const results = await migrateDirectory(directory, dryRun);
  printResults(results, dryRun);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`\nError: ${message}`);
  process.exit(1);
});
