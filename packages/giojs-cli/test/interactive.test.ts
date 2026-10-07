/**
 * giojs-cli/test/interactive.test.ts
 *
 * The prompts on a real terminal: util-linux `script` gives the CLI a
 * pseudo-terminal, and keystrokes are written to it: a full run of the
 * prompts, and Ctrl+C at a question, which must exit cleanly with nothing
 * written. Skipped where `script` is not the util-linux one (macOS,
 * Windows).
 *   npm test   (runs tsc first: the CLI runs from dist/)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanEnv, cliEntry } from './helpers.ts';

const hasScript = process.platform === 'linux'
  && spawnSync('script', ['--version'], { encoding: 'utf8' }).stdout?.includes('util-linux') === true;

interface Session {
  output: () => string;
  type: (keys: string) => void;
  waitFor: (pattern: RegExp) => Promise<void>;
  exit: Promise<number | null>;
}

function startOnTerminal(cwd: string, args: string[] = []): Session {
  const command = [process.execPath, cliEntry, ...args].map(arg => `'${arg}'`).join(' ');
  const child = spawn('script', ['-qec', command, '/dev/null'], { cwd, env: cleanEnv({ TERM: 'xterm' }) });
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  const exit = new Promise<number | null>(resolve => child.once('exit', code => resolve(code)));
  return {
    output: () => output,
    type: keys => { child.stdin.write(keys); },
    waitFor: async pattern => {
      const deadline = Date.now() + 15_000;
      while (!pattern.test(output)) {
        assert.ok(Date.now() < deadline, `timed out waiting for ${pattern}:\n${output}`);
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    },
    exit,
  };
}

test('Ctrl+C at the name prompt exits cleanly and writes nothing', { skip: !hasScript && 'needs util-linux script' }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'gio-interactive-'));
  try {
    const session = startOnTerminal(cwd);
    await session.waitFor(/Project name:/);
    session.type('\x03');
    assert.equal(await session.exit, 130, session.output());
    assert.match(session.output(), /Cancelled - nothing was written/);
    assert.deepEqual(await readdir(cwd), []);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('Ctrl+C at the language picker exits cleanly and writes nothing', { skip: !hasScript && 'needs util-linux script' }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'gio-interactive-'));
  try {
    const session = startOnTerminal(cwd);
    await session.waitFor(/Project name:/);
    session.type('my-app\r');
    await session.waitFor(/Which language/);
    session.type('\x03');
    assert.equal(await session.exit, 130, session.output());
    assert.match(session.output(), /Cancelled - nothing was written/);
    assert.deepEqual(await readdir(cwd), []);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('the prompts ask for what the flags leave open, and sanitize the package name', { skip: !hasScript && 'needs util-linux script' }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'gio-interactive-'));
  try {
    const session = startOnTerminal(cwd, ['--no-git']);
    await session.waitFor(/Project name:/);
    session.type('My App\r');
    await session.waitFor(/Package name:.*my-app/);
    session.type('\r');
    await session.waitFor(/Which language/);
    session.type('\r');
    await session.waitFor(/What are you building/);
    session.type('\x1b[B\r'); // down arrow: Static site
    await session.waitFor(/Install dependencies with npm\?/);
    session.type('n\r');
    assert.equal(await session.exit, 0, session.output());
    const pkg = JSON.parse(await readFile(join(cwd, 'My App', 'package.json'), 'utf8')) as {
      name: string;
      scripts: Record<string, string>;
    };
    assert.equal(pkg.name, 'my-app');
    assert.match(pkg.scripts['build'] ?? '', /^tsc --noEmit && .*export$/);
    assert.match(session.output(), /npm install/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
