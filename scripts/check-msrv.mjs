/**
 * scripts/check-msrv.mjs
 *
 * The minimum supported Rust version is stated once, as `rust-version` under
 * [workspace.package] in the root Cargo.toml. This gate keeps it honest:
 *
 *   - every workspace crate inherits it (`rust-version.workspace = true`), so
 *     cargo rejects an older toolchain with a clear message;
 *   - no crate in Cargo.lock needs a newer rustc (its own `rust-version`, or
 *     1.85 for edition 2024) - otherwise a --locked build on the MSRV
 *     toolchain fails before it compiles anything;
 *   - every `FROM rust:<tag>` in the docs is at least the MSRV, so a
 *     documented from-source Dockerfile can build the committed lockfile.
 *     One said rust:1.78 long after the lockfile needed 1.89. The docs have
 *     no Rust image today (the Docker recipe uses `gio build standalone` with
 *     a prebuilt binary, and from-source builds point at `rust-version`), so
 *     this part guards any that is added later.
 *
 * A dependency bump that needs a newer rustc has to raise `rust-version` (and
 * any `FROM rust:` tag in the docs) in the same change. Exits 1 on any drift.
 *
 *   node scripts/check-msrv.mjs           # check (CI gate)
 *   node scripts/check-msrv.mjs --print   # print the MSRV (CI installs it)
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, relative, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

/** `rust-version` from the root manifest's [workspace.package] table. */
function readMsrv() {
  let section = '';
  for (const line of readFileSync(join(root, 'Cargo.toml'), 'utf8').split(/\r?\n/)) {
    const header = line.match(/^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(?:#.*)?$/);
    if (header) {
      section = header[1];
      continue;
    }
    const value = line.match(/^\s*rust-version\s*=\s*"([^"]*)"/);
    if (value && section === 'workspace.package') return value[1];
  }
  return null;
}

/** "1.89" / "1.89.0" -> [1, 89, 0]; null for anything else. */
function parseVersion(v) {
  const m = /^(\d+)\.(\d+)(?:\.(\d+))?$/.exec(v ?? '');
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null;
}
const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
const show = (v) => v.join('.');

/** The oldest rustc that can parse a manifest of each edition. */
const editionMinimum = { 2015: [1, 0, 0], 2018: [1, 31, 0], 2021: [1, 56, 0], 2024: [1, 85, 0] };

/** Highest rustc a package needs, and why. */
function requirement(pkg) {
  let need = editionMinimum[pkg.edition] ?? [1, 0, 0];
  let why = `edition ${pkg.edition}`;
  const declared = parseVersion(pkg.rust_version);
  if (declared && compare(declared, need) >= 0) {
    need = declared;
    why = `rust-version ${pkg.rust_version}`;
  }
  return { need, why };
}

/** Text files that may carry a Dockerfile: the docs and the docs site. */
function* docFiles(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist', 'out', '.next'].includes(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* docFiles(path);
    } else if (
      ['.md', '.mdx', '.tsx', '.ts', '.jsx', '.js'].includes(extname(entry.name)) ||
      basename(entry.name).startsWith('Dockerfile')
    ) {
      yield path;
    }
  }
}

const raw = readMsrv();
const msrv = parseVersion(raw);
if (!msrv) {
  console.error(
    `Cargo.toml: [workspace.package] rust-version is ${raw === null ? 'missing' : `"${raw}"`} ` +
      '- expected a version like "1.89"',
  );
  process.exit(1);
}
if (process.argv.includes('--print')) {
  console.log(raw);
  process.exit(0);
}

const problems = [];

const metadata = JSON.parse(
  execFileSync('cargo', ['metadata', '--locked', '--format-version', '1'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  }),
);
const members = new Set(metadata.workspace_members);

let memberCount = 0;
let lockedCount = 0;
let highest = [1, 0, 0];
for (const pkg of metadata.packages) {
  if (members.has(pkg.id)) {
    memberCount++;
    const own = parseVersion(pkg.rust_version);
    if (!own || compare(own, msrv) !== 0) {
      const manifest = relative(root, pkg.manifest_path).replaceAll('\\', '/');
      problems.push(
        `${manifest}: rust-version is ${pkg.rust_version ?? 'unset'} - ` +
          'add `rust-version.workspace = true` under [package]',
      );
    }
    continue;
  }
  lockedCount++;
  const { need, why } = requirement(pkg);
  if (compare(need, highest) > 0) highest = need;
  if (compare(need, msrv) > 0) {
    problems.push(
      `Cargo.lock: ${pkg.name} ${pkg.version} needs rustc ${show(need)} (${why}) - ` +
        'raise rust-version in Cargo.toml, or hold the crate back',
    );
  }
}

// `FROM rust:1.89`, `FROM --platform=$X docker.io/library/rust:1.89.0-slim`, ...
// A tag without a minor version (`rust:1`, `rust:slim`, `rust:latest`) floats
// to the newest stable and always satisfies the MSRV; `rust:1.89` floats
// across 1.89.x.
const fromRust = /\bFROM\s+(?:--\S+\s+)*(?:[\w.:-]+\/)*rust:([\w.-]+)/g;
let imageCount = 0;
for (const file of [
  join(root, 'README.md'),
  ...docFiles(join(root, 'docs')),
  ...docFiles(join(root, 'docs-site', 'app')),
]) {
  if (!existsSync(file)) continue;
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const [, tag] of line.matchAll(fromRust)) {
      imageCount++;
      const m = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(tag);
      if (!m) continue;
      const image = [Number(m[1]), Number(m[2]), m[3] === undefined ? Infinity : Number(m[3])];
      if (compare(image, msrv) < 0) {
        problems.push(
          `${relative(root, file).replaceAll('\\', '/')}:${i + 1}: FROM rust:${tag} is older than ` +
            `rust-version ${raw} - cargo build --locked fails on it`,
        );
      }
    }
  });
}

if (problems.length > 0) {
  for (const p of problems) console.error(p);
  console.error(`${problems.length} MSRV problem(s) against rust-version ${raw}`);
  process.exit(1);
}
console.log(
  `MSRV ${raw}: ${memberCount} workspace crates inherit it, ` +
    `${lockedCount} locked crates need at most rustc ${show(highest)}, ` +
    `${imageCount} Rust image(s) in the docs`,
);
