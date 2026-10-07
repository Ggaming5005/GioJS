/**
 * giojs-cli/src/overlays/types.ts
 *
 * A feature overlay is everything one starter feature adds to a project:
 * files (templates/overlays/<name>/{shared,ts,js}, plus generated ones),
 * package.json additions, gio.toml tables, .env lines, .gitignore lines,
 * small anchored edits to files the project already has, and the steps to
 * print afterwards. The same definition applies at create time and to an
 * existing project (`create-giojs add <feature>`), so every part must be
 * idempotent: applying an overlay twice changes nothing the second time.
 */
import type { PackageManager } from './package-manager.js';

export const FEATURE_NAMES = ['tailwind', 'api', 'auth', 'db', 'docker', 'ci'] as const;
export type FeatureName = (typeof FEATURE_NAMES)[number];

export type OverlayLanguage = 'ts' | 'js';
export type OverlayMode = 'server' | 'static';

/** What an overlay knows about the project it is applied to. */
export interface OverlayContext {
  /** The project root. */
  dir: string;
  projectName: string;
  language: OverlayLanguage;
  mode: OverlayMode;
  packageManager: PackageManager;
  /** The parsed package.json as it stands before this overlay applies. */
  packageJson: PackageJson;
}

export interface PackageJson {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  [key: string]: unknown;
}

/** A file whose content is computed (it depends on the context). */
export interface GeneratedFile {
  /** Project-relative, `/`-separated. */
  path: string;
  content: string;
  /**
   * `keep`: an existing file is the user's to edit (an input stylesheet) -
   * leave it alone instead of reporting a conflict.
   */
  onExisting?: 'conflict' | 'keep';
}

/**
 * A script change. A plain string sets a script that must not exist yet
 * with another value; a function rewrites the current value (undefined when
 * absent) and returns it unchanged - or undefined to leave it absent - once
 * the change is already in place.
 */
export type ScriptChange = string | ((current: string | undefined) => string | undefined);

/** One `key = value` inside a `[table]` of gio.toml. */
export interface TomlKey {
  table: string;
  key: string;
  /** A TOML array of strings: merged into an existing array value. */
  values: readonly string[];
  /** Comment lines (without `#`) written above the key when it is added. */
  comment?: readonly string[];
}

/** One `[[table]]` entry, identified by its `path` (guards, redirects...). */
export interface TomlArrayEntry {
  table: string;
  /** Rendered verbatim after the header; must set `path = "..."`. */
  body: string;
  path: string;
  comment?: readonly string[];
}

/**
 * An edit to a file the project already has (the root layout). `apply`
 * returns the new content, the same content when the edit is already in
 * place, or null when the anchor it needs is gone - the user changed the
 * file, so the edit becomes a manual step (`manual`).
 */
export interface FileEdit {
  /** Candidate paths, first existing wins. */
  paths: readonly string[];
  apply(content: string, ctx: OverlayContext): string | null;
  manual: string;
}

export interface Overlay {
  name: FeatureName;
  /** Prompt label and hint. */
  title: string;
  hint: string;
  /** Build targets the feature makes sense for. */
  modes: readonly OverlayMode[];
  /**
   * Directories under templates/overlays/, each with shared/, ts/ and js/
   * file trees. Overlays may share one (_forms): a file another overlay
   * already added with the same content is not a conflict.
   */
  templateDirs?: readonly string[];
  generate?(ctx: OverlayContext): GeneratedFile[];
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?(ctx: OverlayContext): Record<string, ScriptChange>;
  /** Other top-level package.json fields, set only when absent. */
  packageFields?: Record<string, unknown>;
  toml?: { keys?: readonly TomlKey[]; entries?: readonly TomlArrayEntry[] };
  /** Lines per env file (`.env.example`, `.env.development`); a KEY=... line is added when KEY is absent. */
  env?: Record<string, readonly string[]>;
  gitignore?: readonly string[];
  edits?(ctx: OverlayContext): FileEdit[];
  /**
   * Notes for coding agents, appended to AGENTS.md under "Starter features"
   * (one bullet, wrapped lines allowed) so they know where the feature lives.
   */
  agents?: string;
  /** Printed after the overlay applied. */
  postSteps?(ctx: OverlayContext): string[];
}
