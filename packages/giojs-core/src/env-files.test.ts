/**
 * giojs-core/src/env-files.test.ts
 *
 * The Node .env loader must match the Rust one (env_files.rs) exactly:
 * precedence, never overriding existing variables, NODE_ENV handling, and
 * dotenvy's syntax. Every load targets a plain object, never process.env.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EnvFileError, envFileNames, envMode, loadEnvFiles, parseEnvFile } from './env-files.ts';

const roots: string[] = [];

async function projectWith(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'gio-env-files-'));
  roots.push(root);
  for (const [name, contents] of Object.entries(files)) {
    await writeFile(join(root, name), contents);
  }
  return root;
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('envMode / envFileNames', () => {
  it('follows the dev-mode rule: only NODE_ENV=development is development', () => {
    expect(envMode('development')).toBe('development');
    expect(envMode('production')).toBe('production');
    expect(envMode('test')).toBe('production');
    expect(envMode(undefined)).toBe('production');
  });

  it('lists files in Next.js precedence order', () => {
    expect(envFileNames('production')).toEqual([
      '.env.production.local',
      '.env.local',
      '.env.production',
      '.env',
    ]);
  });
});

describe('loadEnvFiles', () => {
  it('lets the first file in precedence order win', async () => {
    const root = await projectWith({
      '.env': 'A=env\nB=env\nC=env\nD=env\n',
      '.env.production': 'A=prod\nB=prod\nC=prod\n',
      '.env.local': 'A=local\nB=local\n',
      '.env.production.local': 'A=prod-local\n',
      '.env.development': 'A=dev\nDEV_ONLY=1\n',
    });
    const env: NodeJS.ProcessEnv = {};
    const loaded = loadEnvFiles(root, { mode: 'production', env });
    expect(env).toEqual({ A: 'prod-local', B: 'local', C: 'prod', D: 'env' });
    expect(loaded.files).toEqual(['.env.production.local', '.env.local', '.env.production', '.env']);
  });

  it('never overrides a variable the environment already has', async () => {
    const root = await projectWith({ '.env': 'TOKEN=from-file\nOTHER=x\n' });
    const env: NodeJS.ProcessEnv = { TOKEN: 'from-process' };
    loadEnvFiles(root, { mode: 'development', env });
    expect(env).toEqual({ TOKEN: 'from-process', OTHER: 'x' });
  });

  it('picks the mode from NODE_ENV in the target env', async () => {
    const root = await projectWith({ '.env.development': 'WHICH=dev\n', '.env.production': 'WHICH=prod\n' });
    const env: NodeJS.ProcessEnv = { NODE_ENV: 'development' };
    expect(loadEnvFiles(root, { env }).mode).toBe('development');
    expect(env['WHICH']).toBe('dev');
  });

  it('ignores and reports NODE_ENV set by a file', async () => {
    const root = await projectWith({ '.env': 'NODE_ENV=development\nX=1\n' });
    const env: NodeJS.ProcessEnv = {};
    const loaded = loadEnvFiles(root, { mode: 'production', env });
    expect(loaded.ignoredNodeEnv).toBe(true);
    expect(env).toEqual({ X: '1' });
  });

  it('loads nothing when no file exists', async () => {
    const root = await projectWith({});
    const env: NodeJS.ProcessEnv = {};
    expect(loadEnvFiles(root, { env }).files).toEqual([]);
    expect(env).toEqual({});
  });

  it('substitutes from a higher-precedence file loaded earlier', async () => {
    const root = await projectWith({ '.env.local': 'HOST=example.com\n', '.env': 'URL=https://${HOST}/api\n' });
    const env: NodeJS.ProcessEnv = {};
    loadEnvFiles(root, { mode: 'production', env });
    expect(env['URL']).toBe('https://example.com/api');
  });

  it('names the file and line on a parse error but never the value', async () => {
    const root = await projectWith({ '.env.local': 'OK=1\n\nSECRET="hunter2-unterminated\n' });
    let caught: unknown;
    try {
      loadEnvFiles(root, { mode: 'production', env: {} });
    } catch (loadError) {
      caught = loadError;
    }
    expect(caught).toBeInstanceOf(EnvFileError);
    const message = (caught as Error).message;
    expect(message).toContain('.env.local');
    expect(message).toContain('line 3');
    expect(message).not.toContain('hunter2');
  });
});

describe('parseEnvFile (dotenvy syntax)', () => {
  it('handles comments, export, quotes, escapes, multiline values and duplicates', () => {
    const source =
      '\uFEFF# comment\nexport EXPORTED=yes\nSINGLE=\'a $b\'\nDOUBLE="line1\\nline2"\n' +
      'MULTI="one\ntwo"\nINLINE=value # trailing comment\nEMPTY=\nDUP=first\nDUP=second\n' +
      'export=as-key\nSPACED  =  "x y"\nCRLF=windows\r\n';
    expect(parseEnvFile(source)).toEqual([
      ['EXPORTED', 'yes'],
      ['SINGLE', 'a $b'],
      ['DOUBLE', 'line1\nline2'],
      ['MULTI', 'one\ntwo'],
      ['INLINE', 'value'],
      ['EMPTY', ''],
      ['DUP', 'first'],
      ['DUP', 'second'],
      ['export', 'as-key'],
      ['SPACED', 'x y'],
      ['CRLF', 'windows'],
    ]);
  });

  it('substitutes $VAR and ${VAR}, environment first, then earlier lines', () => {
    // Same cases as env_files.rs's dotenv_syntax_is_supported.
    const source =
      'GIOTESTBASE=/srv\nBRACED=${GIOTESTBASE}/app\nBARE=$GIOTESTBASE\n' +
      'ESCAPED=\\$GIOTESTBASE\nQUOTED="$GIOTESTBASE/q"\nFROM_ENV=${OUTER}\n';
    const pairs = parseEnvFile(source, key => (key === 'OUTER' ? 'env-value' : undefined));
    expect(Object.fromEntries(pairs)).toEqual({
      GIOTESTBASE: '/srv',
      BRACED: '/srv/app',
      BARE: '/srv',
      ESCAPED: '$GIOTESTBASE',
      QUOTED: '/srv/q',
      FROM_ENV: 'env-value',
    });
  });

  it('rejects malformed lines with the line number', () => {
    expect(() => parseEnvFile('OK=1\nnot a pair\n')).toThrow('invalid syntax on line 2');
    expect(() => parseEnvFile('A=one two\n')).toThrow('invalid syntax on line 1');
    expect(() => parseEnvFile("A='open\nB=2\n")).toThrow('invalid syntax on line 1');
  });
});
