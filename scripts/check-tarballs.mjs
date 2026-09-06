/**
 * scripts/check-tarballs.mjs
 *
 * Publish gate: for each package dir given as an argument, run
 * `npm pack --dry-run --json` and assert that every file referenced by
 * `main`, `types`, `bin`, and `exports` is actually inside the tarball.
 * Exits 1 on any missing file - this is what would have caught the empty
 * @gio.js/react@0.1.0-beta.5 and dist-less create-giojs@0.1.0-beta.5.
 *
 *   node scripts/check-tarballs.mjs packages/giojs-react packages/giojs-cli ...
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dirs = process.argv.slice(2);
if (dirs.length === 0) {
  console.error('usage: node scripts/check-tarballs.mjs <package-dir> [...]');
  process.exit(1);
}

const normalize = (p) => p.replace(/^\.\//, '').replaceAll('\\', '/');

function collectEntryPaths(value, out) {
  // String leaves in main/types/bin/exports are always file paths.
  if (typeof value === 'string') {
    out.add(normalize(value));
  } else if (value && typeof value === 'object') {
    for (const v of Object.values(value)) collectEntryPaths(v, out);
  }
}

let failures = 0;
for (const rel of dirs) {
  const dir = join(root, rel);
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));

  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const packJson = execFileSync(npmCmd, ['pack', '--dry-run', '--json'], {
    cwd: dir,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const tarballFiles = new Set(JSON.parse(packJson)[0].files.map((f) => normalize(f.path)));

  const required = new Set();
  if (pkg.main) required.add(normalize(pkg.main));
  if (pkg.types) required.add(normalize(pkg.types));
  if (pkg.bin) collectEntryPaths(pkg.bin, required);
  if (pkg.exports) collectEntryPaths(pkg.exports, required);

  // Platform binary packages reference their binary via find-binary.js, not
  // package.json fields - require the staged binary explicitly.
  if (pkg.name.startsWith('@gio.js/server-')) {
    const hasBinary = tarballFiles.has('bin/giojs-server') || tarballFiles.has('bin/giojs-server.exe');
    if (!hasBinary) required.add('bin/giojs-server');
  }

  const missing = [...required].filter((p) => !tarballFiles.has(p));
  if (missing.length > 0) {
    failures++;
    console.error(`FAIL ${pkg.name}@${pkg.version} (${rel}): tarball is missing referenced files:`);
    for (const m of missing) console.error(`  - ${m}`);
    console.error(`  tarball has ${tarballFiles.size} file(s). Did the build step run?`);
  } else {
    console.log(`ok   ${pkg.name}@${pkg.version}: ${tarballFiles.size} file(s), all entry points present`);
  }
}

process.exit(failures === 0 ? 0 : 1);
