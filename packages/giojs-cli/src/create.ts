import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { copyTemplate } from './copy-template.js';
import { gatherConfig, type CliArgs, type Language } from './prompts.js';

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { yes: false };
  for (const arg of argv) {
    switch (arg) {
      case '--js':
      case '--javascript':
        args.language = 'js' satisfies Language;
        break;
      case '--ts':
      case '--typescript':
        args.language = 'ts' satisfies Language;
        break;
      case '--no-install':
        args.installDeps = false;
        break;
      case '--install':
        args.installDeps = true;
        break;
      case '-y':
      case '--yes':
        args.yes = true;
        break;
      default:
        if (!arg.startsWith('-') && args.projectName === undefined) {
          args.projectName = arg;
        }
    }
  }
  return args;
}

function monorepoRoot(): string | null {
  // dist/create.js is at packages/giojs-cli/dist/ — four levels up is the workspace root
  const root = join(fileURLToPath(import.meta.url), '..', '..', '..', '..');
  return existsSync(join(root, 'gio.toml')) ? root : null;
}

async function patchPackageJson(destDir: string): Promise<void> {
  const pkgPath = join(destDir, 'package.json');
  const raw = await readFile(pkgPath, 'utf8');
  const pkg = JSON.parse(raw) as Record<string, unknown>;
  const deps = pkg['dependencies'] as Record<string, string>;
  const scripts = pkg['scripts'] as Record<string, string>;

  const root = monorepoRoot();
  if (root !== null) {
    // Local workspace: @gio.js/* aren't published, so file-ref the React package
    // and run the server straight from cargo instead of the @gio.js/server bin.
    delete deps['@gio.js/server'];
    deps['@gio.js/react'] = 'file:../../packages/giojs-react';
    scripts['dev'] = 'cross-env NODE_ENV=development cargo run --manifest-path ../../Cargo.toml -p giojs-server';
    scripts['start'] = 'cargo run --release --manifest-path ../../Cargo.toml -p giojs-server';
  }
  // Published mode keeps the template's pinned @gio.js/* version ranges as-is.

  await writeFile(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
}

export async function create(argv: string[]): Promise<void> {
  const config = await gatherConfig(parseArgs(argv));
  const destDir = join(process.cwd(), config.projectName);

  const langLabel = config.language === 'js' ? 'JavaScript (.jsx)' : 'TypeScript (.tsx)';
  console.log(`\nCreating ${config.projectName} with ${langLabel}...`);
  await copyTemplate(config.template, destDir, config.projectName);
  await patchPackageJson(destDir);
  console.log('Template copied.');

  if (config.installDeps) {
    console.log('Installing dependencies...');
    execSync('npm install', { cwd: destDir, stdio: 'inherit' });
  }

  const steps = config.installDeps
    ? `  cd ${config.projectName}\n  npm run dev`
    : `  cd ${config.projectName}\n  npm install\n  npm run dev`;
  console.log(`\nDone! To get started:\n\n${steps}\n`);
}
