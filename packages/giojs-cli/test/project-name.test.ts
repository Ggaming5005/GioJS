/**
 * giojs-cli/test/project-name.test.ts
 *
 * The npm package name rules (validate-npm-package-name's, for new
 * packages), the sanitized default offered for an invalid directory name,
 * and the non-empty directory check.
 *   npm test   (runs tsc first: these import the built dist/)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sanitizePackageName, validatePackageName } from '../dist/project-name.js';
import { describeNonEmpty, inspectTargetDir } from '../dist/target-dir.js';

test('valid package names pass', () => {
  for (const name of ['my-app', 'app2', 'a.b', 'a_b', 'x', '@acme/web', 'a'.repeat(214)]) {
    assert.equal(validatePackageName(name), undefined, name);
  }
});

test('invalid package names say why', () => {
  const cases: [string, RegExp][] = [
    ['', /empty/],
    ['a'.repeat(215), /longer than 214/],
    [' app', /spaces/],
    ['.app', /dot/],
    ['_app', /underscore/],
    ['My-App', /lowercase/],
    ['my app', /URL-safe/],
    ['app:1', /URL-safe/],
    ['a/b', /URL-safe/],
    ["it's", /~'!\(\)\*/],
    ['node_modules', /reserved/],
    ['favicon.ico', /reserved/],
    ['http', /built-in/],
    ['fs', /built-in/],
    ['@acme/.web', /dot or underscore/],
    ['@ac me/web', /URL-safe/],
  ];
  for (const [name, reason] of cases) {
    assert.match(validatePackageName(name) ?? 'valid', reason, JSON.stringify(name));
  }
});

test('sanitizePackageName turns directory names into valid package names', () => {
  const cases: [string, string][] = [
    ['My App', 'my-app'],
    ['  Hello   World!! ', 'hello-world'],
    ['.hidden', 'hidden'],
    ['__init__', 'init__'],
    ['Café Ünïcode', 'caf-n-code'],
    ['a~b', 'a-b'],
    ['trailing.', 'trailing'],
    ['!!!', 'my-giojs-app'],
    ['.', 'my-giojs-app'],
    ['http', 'http-app'],
    ['node_modules', 'my-giojs-app'],
    ['x'.repeat(300), 'x'.repeat(214)],
  ];
  for (const [raw, expected] of cases) {
    const sanitized = sanitizePackageName(raw);
    assert.equal(sanitized, expected, raw);
    assert.equal(validatePackageName(sanitized), undefined, `${raw} -> ${sanitized}`);
  }
});

test('inspectTargetDir ignores harmless files and lists the rest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gio-target-dir-'));
  try {
    assert.deepEqual(await inspectTargetDir(join(root, 'missing')), { kind: 'missing' });

    const dir = join(root, 'repo');
    await mkdir(join(dir, '.git'), { recursive: true });
    await mkdir(join(dir, '.vscode'));
    for (const name of ['.DS_Store', 'README.md', 'LICENSE']) await writeFile(join(dir, name), '');
    assert.deepEqual(await inspectTargetDir(dir), { kind: 'empty' });

    await writeFile(join(dir, 'package.json'), '{}');
    await mkdir(join(dir, 'src'));
    assert.deepEqual(await inspectTargetDir(dir), { kind: 'not-empty', entries: ['package.json', 'src'] });

    await writeFile(join(root, 'file'), '');
    assert.deepEqual(await inspectTargetDir(join(root, 'file')), { kind: 'not-a-directory' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the non-empty refusal lists what is there and names --force', () => {
  const message = describeNonEmpty('my-app', Array.from({ length: 10 }, (_, i) => `file${i}`));
  assert.match(message, /^my-app is not empty:\n {2}file0\n/);
  assert.match(message, / {2}\.\.\. and 2 more\n/);
  assert.match(message, /--force/);
});
