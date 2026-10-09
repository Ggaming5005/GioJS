/**
 * docs-site/components/ReferenceTable.tsx
 *
 * The tables of an API reference page (docs-site/AGENTS.md has the page
 * template), so every page lays them out alike:
 *
 *   <PropsTable kind="Prop" rows={[
 *     { name: 'href', type: 'string', required: true, description: 'Where the link goes.' },
 *     { name: 'prefetch', type: 'boolean', default: 'true', description: <>...</> },
 *   ]} />
 *
 *   <VersionHistory entries={[{ version: 'v0.1.0-beta.8', changes: 'Introduced.' }]} />
 *
 * Plain server-rendered tables; text and Markdown extraction read them like
 * any other table.
 */
import React from 'react';

export interface PropsRow {
  /** The prop, parameter, option or key, shown as code. */
  name: string;
  /** Its TypeScript (or TOML) type, shown as code. */
  type: string;
  /** The default, shown as code; leave it out for "-". */
  default?: string;
  /** Marks a value the caller must give (shown after the name). */
  required?: boolean;
  description: React.ReactNode;
}

interface PropsTableProps {
  rows: PropsRow[];
  /** What a row is: the first column's heading. */
  kind?: 'Prop' | 'Parameter' | 'Option' | 'Key' | 'Field';
}

export function PropsTable({ rows, kind = 'Prop' }: PropsTableProps): React.JSX.Element {
  return (
    <table className="ref-table">
      <thead>
        <tr><th>{kind}</th><th>Type</th><th>Default</th><th>Description</th></tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.name}>
            <td>
              <code>{row.name}</code>
              {row.required === true && <span className="ref-table__required"> (required)</span>}
            </td>
            <td><code>{row.type}</code></td>
            <td>{row.default !== undefined ? <code>{row.default}</code> : '-'}</td>
            <td>{row.description}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export interface VersionEntry {
  /** As the CHANGELOG names it: 'v0.1.0-beta.8'. */
  version: string;
  changes: React.ReactNode;
}

/** The "Version history" table: newest first, from the CHANGELOG. */
export function VersionHistory({ entries }: { entries: VersionEntry[] }): React.JSX.Element {
  return (
    <table className="ref-table ref-table--versions">
      <thead>
        <tr><th>Version</th><th>Changes</th></tr>
      </thead>
      <tbody>
        {entries.map((entry) => (
          <tr key={entry.version}>
            <td><code>{entry.version}</code></td>
            <td>{entry.changes}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
