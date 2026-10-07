/**
 * giojs-cli/test/workspace.ts
 *
 * Lays out a scaffold's node_modules from the workspace packages, for the
 * tests that typecheck, export or boot a fresh scaffold without an install.
 */
import assert from 'node:assert/strict';
import { mkdir, realpath, symlink } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export const packagesDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const coreDir = join(packagesDir, 'giojs-core');
export const reactDir = join(packagesDir, 'giojs-react');

export function formatDiagnostics(diagnostics: readonly ts.Diagnostic[], base: string): string[] {
  return diagnostics.map(diagnostic => {
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
    if (diagnostic.file === undefined || diagnostic.start === undefined) return message;
    const { line } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
    return `${relative(base, diagnostic.file.fileName)}:${line + 1}: ${message}`;
  });
}

export function parseConfig(configPath: string, overrides: ts.CompilerOptions): ts.ParsedCommandLine {
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, overrides, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: diagnostic => {
      throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
    },
  });
  if (parsed === undefined) throw new Error(`${configPath} did not parse`);
  return parsed;
}

/** Run a package's tsconfig.build.json, emitting into `outDir`. */
export function buildPackage(packageDir: string, outDir: string): void {
  const config = parseConfig(join(packageDir, 'tsconfig.build.json'), { outDir });
  const program = ts.createProgram(config.fileNames, config.options);
  const result = program.emit();
  const errors = formatDiagnostics([...ts.getPreEmitDiagnostics(program), ...result.diagnostics], packageDir);
  assert.deepEqual(errors, [], `building ${packageDir} failed`);
}

/** Link a package the workspace installed (pnpm layout) into `nodeModules`. */
export async function linkInstalled(nodeModules: string, name: string): Promise<void> {
  const target = await realpath(join(coreDir, 'node_modules', name));
  await mkdir(dirname(join(nodeModules, name)), { recursive: true });
  await symlink(target, join(nodeModules, name), 'junction');
}
