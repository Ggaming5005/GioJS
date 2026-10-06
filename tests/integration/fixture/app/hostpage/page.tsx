/**
 * tests/integration/fixture/app/hostpage/page.tsx
 *
 * A page that exports `revalidate` and prints ctx.scheme + ctx.host in a
 * link. The host is whatever the client sent (Host, or X-Forwarded-Host from
 * a trusted proxy), so reading it marks the render personal: an attacker's
 * `Host: evil.example` must never land in a page other visitors are served.
 */
import React from 'react';

export const revalidate = 300;

interface HostProps { href: string; }

export async function getServerSideProps(
  ctx: { scheme?: string; host?: string },
): Promise<{ props: HostProps }> {
  return { props: { href: `${ctx.scheme ?? 'http'}://${ctx.host ?? 'unknown'}/reset` } };
}

export default function HostPage({ href }: HostProps): React.JSX.Element {
  return <a href={href}>HOSTPAGE_FIXTURE reset</a>;
}
