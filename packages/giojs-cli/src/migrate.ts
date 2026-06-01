/**
 * packages/giojs-cli/src/migrate.ts
 *
 * Core transform engine for the gio-migrate command.
 * Applies regex-based transforms to .tsx/.ts/.jsx/.js files to
 * replace Next.js imports with GioJS equivalents.
 */
import { readdir, readFile, writeFile, stat } from 'fs/promises';
import { join, extname, relative } from 'path';

export interface TransformResult {
  filePath: string;
  changed: boolean;
  count: number;
  transforms: string[];
  diff?: string;
}

const SKIP_DIRS = new Set(['node_modules', '.next', '.gio', 'dist', 'out', '.git']);
const SOURCE_EXTENSIONS = new Set(['.tsx', '.ts', '.jsx', '.js']);

export async function findSourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await findSourceFiles(full));
    } else if (SOURCE_EXTENSIONS.has(extname(entry.name))) {
      files.push(full);
    }
  }

  return files;
}

function buildDiff(original: string, transformed: string, filePath: string): string {
  const origLines = original.split('\n');
  const newLines = transformed.split('\n');
  const lines: string[] = [`--- a/${filePath}`, `+++ b/${filePath}`];

  const max = Math.max(origLines.length, newLines.length);
  for (let i = 0; i < max; i++) {
    const orig = origLines[i];
    const next = newLines[i];
    if (orig === next) {
      lines.push(`  ${orig ?? ''}`);
    } else {
      if (orig !== undefined) lines.push(`- ${orig}`);
      if (next !== undefined) lines.push(`+ ${next}`);
    }
  }

  return lines.join('\n');
}

export function transformSource(source: string): { output: string; transforms: string[] } {
  let text = source;
  const transforms: string[] = [];

  // 1. 'use client' removal
  const useClientPattern = /^(['"])use client\1;?\r?\n?/m;
  if (useClientPattern.test(text)) {
    text = text.replace(
      useClientPattern,
      "// GioJS: 'use client' removed — not needed without RSC\n",
    );
    transforms.push("removed 'use client'");
  }

  // 2. next/image → GioImage
  let needsGioImage = false;
  const imageImportPattern = /^import\s+Image\s+from\s+['"]next\/image['"];?\r?\n?/m;
  if (imageImportPattern.test(text)) {
    text = text.replace(imageImportPattern, '');
    needsGioImage = true;
  }

  // 3. next/link → GioLink
  let needsGioLink = false;
  const linkImportPattern = /^import\s+Link\s+from\s+['"]next\/link['"];?\r?\n?/m;
  if (linkImportPattern.test(text)) {
    text = text.replace(linkImportPattern, '');
    needsGioLink = true;
  }

  // 4. Insert combined giojs/react import after removing next/* imports
  if (needsGioImage || needsGioLink) {
    const components = [
      ...(needsGioImage ? ['GioImage'] : []),
      ...(needsGioLink ? ['GioLink'] : []),
    ].join(', ');
    const gioImport = `import { ${components} } from 'giojs/react';\n`;

    // Insert after the last import statement
    const lastImportMatch = [...text.matchAll(/^import\b[^\n]+\n/gm)].pop();
    if (lastImportMatch?.index !== undefined) {
      const insertAt = lastImportMatch.index + lastImportMatch[0].length;
      text = text.slice(0, insertAt) + gioImport + text.slice(insertAt);
    } else {
      text = gioImport + text;
    }

    if (needsGioImage) transforms.push('next/image → GioImage');
    if (needsGioLink) transforms.push('next/link → GioLink');
  }

  // 5. JSX element renaming — must happen after import removal
  if (needsGioImage) {
    // Match <Image followed by whitespace, >, or /
    const jsxImageOpen = /<Image(?=[\s\/>])/g;
    const jsxImageClose = /<\/Image>/g;
    const imageCount = (text.match(jsxImageOpen) ?? []).length + (text.match(jsxImageClose) ?? []).length;
    text = text.replace(jsxImageOpen, '<GioImage');
    text = text.replace(jsxImageClose, '</GioImage>');
    if (imageCount > 0) transforms.push(`<Image /> → <GioImage /> ×${imageCount}`);
  }

  if (needsGioLink) {
    const jsxLinkOpen = /<Link(?=[\s\/>])/g;
    const jsxLinkClose = /<\/Link>/g;
    const linkCount = (text.match(jsxLinkOpen) ?? []).length + (text.match(jsxLinkClose) ?? []).length;
    text = text.replace(jsxLinkOpen, '<GioLink');
    text = text.replace(jsxLinkClose, '</GioLink>');
    if (linkCount > 0) transforms.push(`<Link /> → <GioLink /> ×${linkCount}`);
  }

  // 6. next/navigation → giojs/navigation
  const navPattern = /from\s+['"]next\/navigation['"]/g;
  if (navPattern.test(text)) {
    text = text.replace(/from\s+(['"])next\/navigation\1/g, "from 'giojs/navigation'");
    transforms.push('next/navigation → giojs/navigation');
  }

  // 7. next/font → TODO comment (leave import intact)
  const fontPattern = /^(import\s+[^\n]+from\s+['"]next\/font\/(?:google|local)['"][^\n]*)/m;
  if (fontPattern.test(text)) {
    text = text.replace(
      fontPattern,
      '// TODO: move font declaration to gio.toml [[fonts]] — see docs/deployment/README.md\n$1',
    );
    transforms.push('next/font → TODO comment (move to gio.toml)');
  }

  return { output: text, transforms };
}

export async function transformFile(
  filePath: string,
  dryRun: boolean,
  rootDir: string,
): Promise<TransformResult> {
  const source = await readFile(filePath, 'utf8');
  const { output, transforms } = transformSource(source);
  const changed = output !== source;
  const rel = relative(rootDir, filePath).replace(/\\/g, '/');

  if (!changed) {
    return { filePath: rel, changed: false, count: 0, transforms: [] };
  }

  const result: TransformResult = {
    filePath: rel,
    changed: true,
    count: transforms.length,
    transforms,
  };

  if (dryRun) {
    result.diff = buildDiff(source, output, rel);
  } else {
    await writeFile(filePath, output, 'utf8');
  }

  return result;
}

export async function migrateDirectory(
  dir: string,
  dryRun: boolean,
): Promise<TransformResult[]> {
  await stat(dir);
  const files = await findSourceFiles(dir);
  return Promise.all(files.map(f => transformFile(f, dryRun, dir)));
}
