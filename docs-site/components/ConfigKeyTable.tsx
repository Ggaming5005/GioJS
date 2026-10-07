/**
 * docs-site/components/ConfigKeyTable.tsx
 *
 * The key table of a gio.toml section page (/docs/configuration/<section>,
 * see docs-site/AGENTS.md): one row per key with its type, default, what
 * `0` / `false` / an empty value means, the environment variable that overrides it, and a
 * description that says what turning it off or loosening it costs. Three
 * columns (key and type, default, description with the `0` meaning and the
 * env override under it) keep the description readable in the content column.
 *
 *   <ConfigKeyTable rows={[
 *     { key: 'max_body_bytes', type: 'integer', default: '2097152',
 *       zero: 'No limit of its own', description: <>...</> },
 *   ]} />
 *
 * Write `default` as the TOML literal (`"0.0.0.0"`, `3000`, `true`, `[]`):
 * scripts/docs-content.test.mjs compares it with the default in
 * packages/giojs/gio.schema.json. Leave it out for a key with no default.
 */
import React from 'react';

export interface ConfigKeyRow {
  /** The key as written in gio.toml, shown as code. */
  key: string;
  /** Its TOML type, shown under the key. */
  type: string;
  /** The default as a TOML literal, shown as code; leave it out for "-". */
  default?: string;
  /** The key must be set (array-of-tables entries). */
  required?: boolean;
  /** What `0`, `false` or an empty value means, when that is special. */
  zero?: React.ReactNode;
  /** The environment variable that overrides the key. */
  env?: string;
  description: React.ReactNode;
}

export function ConfigKeyTable({ rows }: { rows: ConfigKeyRow[] }): React.JSX.Element {
  return (
    <table className="ref-table config-key-table">
      <thead>
        <tr><th>Key</th><th>Default</th><th>Description</th></tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.key}>
            <td>
              <code>{row.key}</code>
              {row.required === true && <span className="ref-table__required"> (required)</span>}
              <span className="config-key-table__type">{row.type}</span>
            </td>
            <td>{row.default !== undefined ? <code>{row.default}</code> : '-'}</td>
            <td>
              {row.description}
              {row.zero !== undefined && (
                <span className="config-key-table__meta">
                  <strong><code>0</code> / <code>false</code> / empty:</strong> {row.zero}
                </span>
              )}
              {row.env !== undefined && (
                <span className="config-key-table__meta">
                  <strong>Env override:</strong> <code>{row.env}</code>
                </span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * The startup warnings a section's loosened keys log, quoted exactly as
 * `config_check::protections_off_warnings` writes them (and as
 * `giojs-server --check-config` reports them under `warnings`).
 */
export function StartupWarnings({ rows }: { rows: { when: React.ReactNode; text: string }[] }): React.JSX.Element {
  return (
    <table className="config-warnings">
      <thead>
        <tr><th>When</th><th>Startup warning</th></tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.text}>
            <td>{row.when}</td>
            <td><code>{row.text}</code></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
