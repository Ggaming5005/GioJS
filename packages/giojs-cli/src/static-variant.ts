/**
 * giojs-cli/src/static-variant.ts
 *
 * Turns a scaffolded server app into a static site. The templates serve
 * both modes - every page already works under `gio export` (getStaticPaths
 * on the dynamic route, no request-dependent data on the others) - except
 * for what only the Rust server does: `[[fonts]]` in gio.toml are applied by
 * the server, and an export has none. A static site declares the same font
 * files with @font-face in app/globals.css instead, which the CSS pipeline
 * copies next to the stylesheet with hashed names, in dev and in out/.
 *
 * Each edit looks for an exact anchor in the template and throws when it is
 * missing, so a template change that breaks the variant fails the tests
 * instead of scaffolding a half-converted project.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** The comment that opens the font entries, which close gio.toml. */
const FONTS_ANCHOR = '# Self-hosted fonts:';
const COMMANDS_ANCHOR = '## Commands';

export interface FontEntry {
  family: string;
  url: string;
  weight: number;
  style: string;
}

/** The `[[fonts]]` entries of a gio.toml section (string and number values only). */
export function parseFontEntries(toml: string): FontEntry[] {
  return toml
    .split('[[fonts]]')
    .slice(1)
    .map(block => {
      const values = new Map<string, string>();
      for (const line of block.split('\n')) {
        const match = /^\s*(\w+)\s*=\s*(?:"([^"]*)"|(\d+))/.exec(line);
        if (match?.[1] !== undefined) values.set(match[1], match[2] ?? match[3] ?? '');
      }
      const family = values.get('family');
      const url = values.get('url');
      if (family === undefined || url === undefined) {
        throw new Error(`gio.toml: a [[fonts]] entry needs family and url:\n${block.trim()}`);
      }
      return {
        family,
        url,
        weight: Number(values.get('weight') ?? 400),
        style: values.get('style') ?? 'normal',
      };
    });
}

/** @font-face rules for app/globals.css, pointing at the same public/ files. */
export function fontFaceCss(entries: FontEntry[]): string {
  const rules = entries.map(entry => {
    // '/public/fonts/a.woff2' and '/fonts/a.woff2' both name public/fonts/a.woff2.
    const relative = entry.url.replace(/^\/+/, '').replace(/^public\//, '');
    return (
      `@font-face {\n  font-family: '${entry.family}';\n` +
      `  src: url('../public/${relative}') format('woff2');\n` +
      `  font-weight: ${entry.weight};\n  font-style: ${entry.style};\n  font-display: swap;\n}`
    );
  });
  return (
    '/* Self-hosted fonts. A static export has no GioJS server to apply gio.toml\n' +
    '   [[fonts]], so they are declared here; the files are bundled next to this\n' +
    '   stylesheet with hashed names. */\n' +
    rules.join('\n') +
    '\n\n'
  );
}

function sectionFrom(source: string, anchor: string, file: string): number {
  const index = source.indexOf(anchor);
  if (index === -1) throw new Error(`static variant: "${anchor}" not found in ${file}`);
  return index;
}

function staticCommands(typescript: boolean): string {
  const typecheck = typescript ? 'typechecks (`tsc --noEmit`), then ' : '';
  return `${COMMANDS_ANCHOR}

This is a static site: \`npm run build\` ${typecheck}runs \`gio export\`,
which pre-renders every page to plain HTML in \`out/\` - deploy that folder
to any static host. Route handlers, actions, WebSockets and per-request data
need the server; a dynamic route exports the params its \`getStaticPaths\`
lists.

- \`npm run dev\` — dev server with watch mode + browser reload
- \`npm run build\` — export to \`out/\`
- Dev dashboard: \`/_gio/devtools\` (dev only; answers localhost hosts only,
  add LAN IPs/hostnames to \`[dev] allowed_hosts\`)
- \`npx create-giojs add <feature>\` — add tailwind or ci (the other starter
  features need the server; never overwrites a changed file; safe to rerun)
`;
}

export async function applyStaticVariant(destDir: string, typescript: boolean): Promise<void> {
  const tomlPath = join(destDir, 'gio.toml');
  const toml = await readFile(tomlPath, 'utf8');
  const fontsAt = sectionFrom(toml, FONTS_ANCHOR, 'gio.toml');
  const fonts = parseFontEntries(toml.slice(fontsAt));
  await writeFile(
    tomlPath,
    toml.slice(0, fontsAt) +
      '# Fonts: a static export has no GioJS server to apply [[fonts]] entries,\n' +
      '# so app/globals.css declares the files in public/fonts/ with @font-face.\n',
    'utf8',
  );

  const cssPath = join(destDir, 'app', 'globals.css');
  const css = await readFile(cssPath, 'utf8');
  await writeFile(cssPath, fontFaceCss(fonts) + css, 'utf8');

  const agentsPath = join(destDir, 'AGENTS.md');
  const agents = await readFile(agentsPath, 'utf8');
  const commandsAt = sectionFrom(agents, COMMANDS_ANCHOR, 'AGENTS.md');
  await writeFile(agentsPath, agents.slice(0, commandsAt) + staticCommands(typescript), 'utf8');
}
