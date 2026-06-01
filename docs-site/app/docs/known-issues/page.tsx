import React from 'react';

export const revalidate = false;

interface Issue {
  id: string;
  title: string;
  symptom: string;
  fix: string;
  status: 'Fixed' | 'Open' | 'Wontfix';
  fixedIn: string;
}

const ISSUES: Issue[] = [
  {
    id: 'CORE-001',
    title: 'layout.tsx files not discovered or applied',
    symptom:
      'Pages rendered without any layout wrapper. Root layout providing <html> was ignored, ' +
      'causing wrapWithDocument to add a duplicate <html> shell around the rendered content.',
    fix:
      'Added discoverLayouts() to router.ts (walks app/ collecting layout.tsx files keyed by ' +
      'URL prefix) and layout wrapping logic to ssr.ts. Layouts are applied outermost-first. ' +
      'wrapWithDocument is skipped when a root layout exists at "/".',
    status: 'Fixed',
    fixedIn: 'P3.7',
  },
  {
    id: 'CORE-002',
    title: 'revalidate = false produces cacheMaxAge = 0',
    symptom:
      'Pages with export const revalidate = false were never cached. ' +
      'In Next.js, false means "cache forever." In giojs-core, the expression ' +
      'false ?? 0 evaluates to false (JavaScript ?? only checks null/undefined, not falsy), ' +
      'which is coerced to 0 by JSON serialization. The Rust cache layer requires ' +
      'cache_max_age > 0 to store an entry.',
    fix:
      'Updated ssr.ts lines 123-124: ' +
      'cacheMaxAge: pageModule.revalidate === false ? 31536000 : (pageModule.revalidate ?? 0). ' +
      '31536000 seconds (one year) is the standard "cache indefinitely" sentinel.',
    status: 'Fixed',
    fixedIn: 'P3.7',
  },
  {
    id: 'CORE-003',
    title: 'No server-side redirect support in getServerSideProps',
    symptom:
      'getServerSideProps could only return props (Record<string, unknown>). ' +
      'There was no mechanism to return a 301/302 redirect, making it impossible ' +
      'to implement root-level redirects (e.g., / → /docs/getting-started) without a workaround.',
    fix:
      'Added RedirectResult interface and updated getServerSideProps return type to ' +
      'Promise<Record<string, unknown> | RedirectResult>. ' +
      'ssr.ts now detects redirect returns with an isRedirect() type guard and returns ' +
      'an IPCResponse with status 301/302 and a location header.',
    status: 'Fixed',
    fixedIn: 'P3.7',
  },
];

function StatusBadge({ status }: { status: Issue['status'] }): React.JSX.Element {
  const colors: Record<Issue['status'], string> = {
    Fixed: '#3fb950',
    Open: '#f85149',
    Wontfix: '#8b949e',
  };
  return (
    <span style={{
      color: colors[status],
      fontWeight: 600,
      fontSize: '0.85rem',
      border: `1px solid ${colors[status]}`,
      borderRadius: 4,
      padding: '0.1rem 0.5rem',
    }}>
      {status}
    </span>
  );
}

export default function KnownIssuesPage(): React.JSX.Element {
  return (
    <>
      <h1>Known Issues</h1>
      <p className="page-subtitle">
        Bugs discovered during the P3.7 dogfooding phase (building this docs site on GioJS).
        All three were fixed before the docs site shipped — per the project rule:
        &ldquo;Any workaround is a bug to fix first.&rdquo;
      </p>

      {ISSUES.map(issue => (
        <section key={issue.id} style={{ marginBottom: '2.5rem' }}>
          <h2 style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <code style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>{issue.id}</code>
            {issue.title}
            <StatusBadge status={issue.status} />
          </h2>
          <h3>Symptom</h3>
          <p>{issue.symptom}</p>
          <h3>Fix</h3>
          <p>{issue.fix}</p>
          {issue.status === 'Fixed' && (
            <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>
              Fixed in: {issue.fixedIn}
            </p>
          )}
        </section>
      ))}

      <div className="callout">
        To report a new issue, open a GitHub issue at the GioJS repository.
        Include the GioJS version, Node.js version, and a minimal reproduction.
      </div>
    </>
  );
}
