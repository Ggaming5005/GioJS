import type { DatabaseSync } from 'node:sqlite';

/** drizzle/ under the working directory (the project root, or the standalone folder). */
export declare const MIGRATIONS_FOLDER: string;

/** Apply pending migrations in one transaction; returns how many ran. */
export declare function migrate(sqlite: DatabaseSync, migrationsFolder?: string): number;
