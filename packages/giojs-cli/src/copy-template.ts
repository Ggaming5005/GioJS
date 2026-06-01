import { readFile, writeFile, readdir, mkdir } from 'fs/promises';
import { join } from 'path';
import { fileURLToPath } from 'url';

const TEMPLATES_DIR = join(fileURLToPath(import.meta.url), '..', '..', 'templates');

export async function copyTemplate(
  templateName: string,
  destDir: string,
  projectName: string,
): Promise<void> {
  const srcDir = join(TEMPLATES_DIR, templateName);
  await copyDir(srcDir, destDir, projectName);
}

async function copyDir(src: string, dest: string, projectName: string): Promise<void> {
  await mkdir(dest, { recursive: true });
  const entries = await readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath, projectName);
    } else {
      const content = await readFile(srcPath, 'utf8');
      await writeFile(destPath, content.replaceAll('{{PROJECT_NAME}}', projectName), 'utf8');
    }
  }
}
