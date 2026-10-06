/**
 * tests/integration/fixture/app/personal/page.tsx
 *
 * A page that exports `revalidate` but personalizes from the `who` cookie.
 * Reading ctx.cookies marks the render personal, so it must never be cached
 * under the shared key: every visitor gets their own render.
 */
import React from 'react';

export const revalidate = 60;

interface PersonalProps { who: string; }

export async function getServerSideProps(
  ctx: { cookies: Record<string, string> },
): Promise<{ props: PersonalProps }> {
  return { props: { who: ctx.cookies['who'] ?? 'anon' } };
}

export default function Personal({ who }: PersonalProps): React.JSX.Element {
  return <p>{`PERSONAL_FIXTURE who=${who}`}</p>;
}
