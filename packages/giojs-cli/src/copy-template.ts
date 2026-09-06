/**
 * giojs-cli/src/copy-template.ts
 *
 * Recursively copies a scaffold template to the destination directory.
 * Text files go through {{PROJECT_NAME}} substitution; anything else
 * (favicons, images, fonts) is byte-copied so binary content survives.
 */
import { readFile, writeFile, readdir, mkdir, copyFile } from 'fs/promises';
import { join, extname } from 'path';
import { fileURLToPath } from 'url';

const TEMPLATES_DIR = join(fileURLToPath(import.meta.url), '..', '..', 'templates');

const TEXT_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.json',
  '.css',
  '.html',
  '.md',
  '.toml',
  '.svg',
  '.txt',
]);

/** True for files safe to read as UTF-8 and run through placeholder substitution. */
export function isTextTemplateFile(fileName: string): boolean {
  if (fileName.startsWith('.')) return true;
  return TEXT_EXTENSIONS.has(extname(fileName).toLowerCase());
}

export async function copyTemplate(
  templateName: string,
  destDir: string,
  projectName: string,
): Promise<void> {
  const srcDir = join(TEMPLATES_DIR, templateName);
  await copyDir(srcDir, destDir, projectName);
}

export async function copyDir(src: string, dest: string, projectName: string): Promise<void> {
  await mkdir(dest, { recursive: true });
  const entries = await readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath, projectName);
    } else if (isTextTemplateFile(entry.name)) {
      const content = await readFile(srcPath, 'utf8');
      await writeFile(destPath, content.replaceAll('{{PROJECT_NAME}}', projectName), 'utf8');
    } else {
      await copyFile(srcPath, destPath);
    }
  }
}
