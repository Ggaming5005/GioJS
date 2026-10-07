/**
 * giojs-cli/test/copy-template.test.ts
 *
 * Regression tests for template copying: text files get {{PROJECT_NAME}}
 * substitution, binary assets are byte-copied untouched. Uses the Node
 * built-in runner (this package has no vitest):
 *   node --test test/copy-template.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Buffer } from 'node:buffer';
import { copyDir, isTextTemplateFile, scaffoldFileName } from '../src/copy-template.ts';

const INVALID_UTF8_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x9c, 0x80, 0xfe]);

test('isTextTemplateFile accepts text extensions and dotfiles', () => {
  for (const name of ['page.tsx', 'index.ts', 'app.js', 'gio.toml', 'style.css', 'STYLE.CSS', 'readme.md', 'icon.svg', '.gitignore', '.env']) {
    assert.equal(isTextTemplateFile(name), true, name);
  }
});

test('isTextTemplateFile rejects binary asset extensions', () => {
  for (const name of ['favicon.ico', 'logo.png', 'photo.jpg', 'font.woff2', 'archive.zip']) {
    assert.equal(isTextTemplateFile(name), false, name);
  }
});

test('copyDir substitutes the project name in text files but byte-copies binary files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gio-copy-template-'));
  try {
    const src = join(root, 'src');
    const dest = join(root, 'dest');
    await mkdir(join(src, 'public'), { recursive: true });
    await writeFile(join(src, 'package.json'), '{"name":"{{PROJECT_NAME}}"}', 'utf8');
    await writeFile(join(src, 'public', 'favicon.ico'), INVALID_UTF8_BYTES);

    await copyDir(src, dest, 'my-app');

    const pkg = await readFile(join(dest, 'package.json'), 'utf8');
    assert.equal(pkg, '{"name":"my-app"}');

    // The old UTF-8 read/write path mangled these bytes into U+FFFD.
    const favicon = await readFile(join(dest, 'public', 'favicon.ico'));
    assert.deepEqual([...favicon], [...INVALID_UTF8_BYTES]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('copyDir writes _gitignore as .gitignore, at any depth', async () => {
  // npm never packs a file named .gitignore, so templates ship _gitignore.
  assert.equal(scaffoldFileName('_gitignore'), '.gitignore');
  assert.equal(scaffoldFileName('gitignore'), 'gitignore');
  const root = await mkdtemp(join(tmpdir(), 'gio-copy-template-'));
  try {
    const src = join(root, 'src');
    await mkdir(join(src, 'nested'), { recursive: true });
    await writeFile(join(src, '_gitignore'), 'node_modules/\n');
    await writeFile(join(src, 'nested', '_gitignore'), '*.log\n');

    const written = await copyDir(src, join(root, 'dest'), 'my-app');

    // The written list names files as git does (a --force scaffold commits only these).
    assert.deepEqual(written.sort(), ['.gitignore', 'nested/.gitignore']);
    assert.deepEqual((await readdir(join(root, 'dest'))).sort(), ['.gitignore', 'nested']);
    assert.equal(await readFile(join(root, 'dest', '.gitignore'), 'utf8'), 'node_modules/\n');
    assert.equal(await readFile(join(root, 'dest', 'nested', '.gitignore'), 'utf8'), '*.log\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('copyDir stops before the next file once its signal is aborted', async () => {
  // Ctrl+C mid-scaffold aborts the copy, then rolls back: no write may land
  // after the rollback removed the directory.
  const root = await mkdtemp(join(tmpdir(), 'gio-copy-template-'));
  try {
    const src = join(root, 'src');
    await mkdir(src, { recursive: true });
    for (const name of ['a.txt', 'b.txt', 'c.txt']) await writeFile(join(src, name), name);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(copyDir(src, join(root, 'dest'), 'my-app', controller.signal), { name: 'AbortError' });
    assert.deepEqual(await readdir(join(root, 'dest')), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
