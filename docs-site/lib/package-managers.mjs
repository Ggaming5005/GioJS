/**
 * docs-site/lib/package-managers.mjs
 *
 * An npm command as pnpm, yarn and bun would write it, for PmTabs: the
 * docs write `npm install x` once and every reader sees their own tool.
 * Line by line; lines that are not npm/npx (cd, comments) stay as written.
 * A command this does not know is kept as npm wrote it, so a PmTabs with
 * an unusual command passes its own `pnpm`/`yarn`/`bun` text instead.
 * Types: package-managers.d.mts.
 */

export const PACKAGE_MANAGERS = ['npm', 'pnpm', 'yarn', 'bun'];

/** npm's own commands, which `npm run` is not needed for. */
const NPM_SCRIPTS = new Set(['test', 'start', 'stop', 'restart']);

/** Built-in pnpm/yarn commands a script name can shadow: those keep `run` (`pnpm run deploy`). */
const BUILTINS = new Set([
  'add', 'audit', 'bin', 'cache', 'config', 'create', 'deploy', 'dlx', 'env', 'exec', 'fetch', 'import',
  'info', 'init', 'install', 'link', 'list', 'outdated', 'pack', 'patch', 'prune', 'publish', 'rebuild',
  'remove', 'root', 'server', 'setup', 'store', 'unlink', 'update', 'upgrade', 'version', 'why',
]);

/** `[flags, rest]`: install flags turned into each manager's spelling. */
function installFlags(args, pm) {
  const flags = [];
  const rest = [];
  let global = false;
  for (const arg of args) {
    if (arg === '-D' || arg === '--save-dev') flags.push(pm === 'bun' ? '-d' : '-D');
    else if (arg === '-E' || arg === '--save-exact') flags.push(pm === 'bun' ? '--exact' : '-E');
    else if (arg === '-g' || arg === '--global') global = true;
    else if (arg === '-S' || arg === '--save') continue;
    else rest.push(arg);
  }
  return { flags, rest, global };
}

/** `args` with npm's `--` separator dropped: the others pass flags straight on. */
const withoutSeparator = (args) => args.filter((arg, i) => !(arg === '--' && i === args.indexOf('--')));

function convertNpm(args, pm) {
  const [command = '', ...rest] = args;
  switch (command) {
    case 'install':
    case 'i':
    case 'add': {
      if (rest.length === 0 || rest.every((arg) => arg.startsWith('-'))) {
        if (pm === 'yarn') return ['yarn', ...rest];
        return [pm, 'install', ...rest];
      }
      const { flags, rest: packages, global } = installFlags(rest, pm);
      if (pm === 'yarn' && global) return ['yarn', 'global', 'add', ...flags, ...packages];
      return [pm, 'add', ...(global ? ['-g'] : []), ...flags, ...packages];
    }
    case 'ci':
      if (pm === 'pnpm') return ['pnpm', 'install', '--frozen-lockfile'];
      if (pm === 'yarn') return ['yarn', 'install', '--frozen-lockfile'];
      return ['bun', 'install', '--frozen-lockfile'];
    case 'uninstall':
    case 'remove':
    case 'rm':
      return [pm, 'remove', ...rest];
    case 'run':
    case 'run-script': {
      const [script, ...scriptArgs] = rest;
      if (script === undefined) return undefined;
      // `bun <script>` would run a file of that name if one exists; `bun run` never does.
      const run = pm === 'bun' || BUILTINS.has(script) ? [pm, 'run'] : [pm];
      return [...run, script, ...withoutSeparator(scriptArgs)];
    }
    case 'create':
    case 'init': {
      const [initializer, ...initArgs] = rest;
      if (initializer === undefined) return undefined;
      // npm caches initializers, so it asks for @latest; the others fetch it every time.
      const name = initializer.replace(/@latest$/, '');
      return [pm, 'create', name, ...withoutSeparator(initArgs)];
    }
    case 'exec':
      return convertNpx(withoutSeparator(rest), pm);
    default:
      if (NPM_SCRIPTS.has(command)) return [...(pm === 'bun' ? ['bun', 'run'] : [pm]), command, ...rest];
      return undefined;
  }
}

/**
 * `npx bin ...`: a package the project has (`npx gio dev`) runs with
 * `pnpm exec` / `yarn` / `bunx`; one fetched for the run (a scoped or
 * versioned spec, or `create-*`) with `pnpm dlx` / `yarn dlx` / `bunx`.
 */
function convertNpx(args, pm) {
  const flagless = args.filter((arg) => arg !== '-y' && arg !== '--yes');
  const [bin, ...rest] = flagless;
  if (bin === undefined) return undefined;
  const remote = bin.includes('@') || bin.startsWith('create-');
  if (pm === 'pnpm') return ['pnpm', remote ? 'dlx' : 'exec', bin, ...rest];
  if (pm === 'yarn') return remote ? ['yarn', 'dlx', bin, ...rest] : ['yarn', bin, ...rest];
  return ['bunx', bin, ...rest];
}

/** One line of a command, for `pm`. */
function convertLine(line, pm) {
  const match = /^(\s*)(npm|npx)\s+(.*?)(\s+#.*)?$/.exec(line);
  if (match === null) return line;
  const [, indent, tool, argText, comment = ''] = match;
  // Quoted arguments are rare in install lines; leave such a line alone.
  if (/["'`$\\]/.test(argText)) return line;
  const args = argText.split(/\s+/).filter(Boolean);
  const converted = tool === 'npx' ? convertNpx(args, pm) : convertNpm(args, pm);
  if (converted === undefined) return line;
  const body = `${indent}${converted.join(' ')}`;
  if (comment === '') return body;
  // Keep a trailing comment in its column, so the comments of a block stay aligned.
  const text = comment.trimStart();
  return `${body.padEnd(line.length - text.length - 1)} ${text}`;
}

/**
 * `npm` (one or more lines) as each package manager writes it:
 * `{ npm, pnpm, yarn, bun }`.
 */
export function pmCommands(npm) {
  const commands = { npm };
  for (const pm of PACKAGE_MANAGERS.slice(1)) {
    commands[pm] = npm.split('\n').map((line) => convertLine(line, pm)).join('\n');
  }
  return commands;
}
