/**
 * giojs-cli/src/copy-template.ts
 *
 * Recursively copies a scaffold template to the destination directory.
 * Text files go through {{PROJECT_NAME}} substitution; anything else
 * (favicons, images, fonts) is byte-copied so binary content survives.
 * Files npm would drop from a published package ship under a placeholder
 * name and are renamed on copy (see PUBLISH_RENAMES).
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

/**
 * npm never packs a file named .gitignore (it reads it as the package's
 * ignore list instead), so the templates ship _gitignore.
 */
const PUBLISH_RENAMES: Record<string, string> = {
  _gitignore: '.gitignore',
};

/** The name a template file is written under in the new project. */
export function scaffoldFileName(templateFileName: string): string {
  return PUBLISH_RENAMES[templateFileName] ?? templateFileName;
}

/** True for files safe to read as UTF-8 and run through placeholder substitution. */
export function isTextTemplateFile(fileName: string): boolean {
  if (fileName.startsWith('.')) return true;
  return TEXT_EXTENSIONS.has(extname(fileName).toLowerCase());
}

export function templateDir(templateName: string): string {
  return join(TEMPLATES_DIR, templateName);
}

/** Returns the files written, as {@link copyDir} does. */
export async function copyTemplate(
  templateName: string,
  destDir: string,
  projectName: string,
  signal?: AbortSignal,
): Promise<string[]> {
  return copyDir(templateDir(templateName), destDir, projectName, signal);
}

/**
 * `signal` stops the copy before the next file, so a rollback never races a
 * write. Returns the files written, relative to `dest` and '/'-separated
 * (the way git names them).
 */
export async function copyDir(src: string, dest: string, projectName: string, signal?: AbortSignal): Promise<string[]> {
  await mkdir(dest, { recursive: true });
  const written: string[] = [];
  const entries = await readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    signal?.throwIfAborted();
    const name = scaffoldFileName(entry.name);
    const srcPath = join(src, entry.name);
    const destPath = join(dest, name);
    if (entry.isDirectory()) {
      for (const file of await copyDir(srcPath, destPath, projectName, signal)) written.push(`${name}/${file}`);
      continue;
    }
    if (isTextTemplateFile(entry.name)) {
      const content = await readFile(srcPath, 'utf8');
      await writeFile(destPath, content.replaceAll('{{PROJECT_NAME}}', projectName), 'utf8');
    } else {
      await copyFile(srcPath, destPath);
    }
    written.push(name);
  }
  return written;
}
