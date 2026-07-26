/**
 * scripts/sync-versions.mjs
 *
 * Single source of truth for every published @gio.js/* version. The wrapper
 * (packages/giojs) defines the release version; this script stamps it onto
 * every publishable package, the wrapper's platform/core pins, and the CLI
 * templates' dependency ranges — so a release can never ship a beta-N
 * wrapper pinning beta-M binaries again.
 *
 *   node scripts/sync-versions.mjs           # stamp everything
 *   node scripts/sync-versions.mjs --check   # exit 1 on any mismatch (CI gate)
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const checkOnly = process.argv.includes('--check');

const read = (p) => JSON.parse(readFileSync(p, 'utf8'));
const version = read(join(root, 'packages/giojs/package.json')).version;

/** Packages whose own `version` field must equal the release version. */
const versionedPackages = [
  'packages/giojs',
  'packages/giojs-core',
  'packages/giojs-react',
  'packages/giojs-cli',
  ...readdirSync(join(root, 'platform')).map((d) => `platform/${d}`),
];

/** package.json files whose @gio.js/* dependency entries must track it. */
const dependentFiles = [
  { file: 'packages/giojs/package.json', exact: true },
  { file: 'packages/giojs-cli/templates/default/package.json', exact: false },
  { file: 'packages/giojs-cli/templates/default-js/package.json', exact: false },
];

let mismatches = 0;
const report = (file, field, actual, expected) => {
  mismatches++;
  console.log(`${checkOnly ? 'MISMATCH' : 'stamping'}: ${file} ${field}: ${actual} -> ${expected}`);
};

for (const rel of versionedPackages) {
  const file = join(root, rel, 'package.json');
  const pkg = read(file);
  if (pkg.version !== version) {
    report(rel, 'version', pkg.version, version);
    if (!checkOnly) {
      pkg.version = version;
      writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');
    }
  }
}

for (const { file: rel, exact } of dependentFiles) {
  const file = join(root, rel);
  const pkg = read(file);
  const expected = exact ? version : `^${version}`;
  let changed = false;
  for (const section of ['dependencies', 'optionalDependencies']) {
    for (const [name, current] of Object.entries(pkg[section] ?? {})) {
      if (!name.startsWith('@gio.js/')) continue;
      if (current !== expected) {
        report(rel, `${section}.${name}`, current, expected);
        pkg[section][name] = expected;
        changed = true;
      }
    }
  }
  if (changed && !checkOnly) {
    writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');
  }
}

if (mismatches === 0) {
  console.log(`all packages in lockstep at ${version}`);
} else if (checkOnly) {
  console.error(`${mismatches} version mismatch(es) — run: node scripts/sync-versions.mjs`);
  process.exit(1);
} else {
  console.log(`stamped ${mismatches} field(s) to ${version}`);
}
