import { redirect } from '@gio.js/core';
// TODO(gio-migrate): types from 'next' (GetServerSidePropsContext) don't exist in GioJS: getServerSideProps receives { params, query, headers, cookies, locale }, route handlers a GioRequest (@gio.js/core), pages plain props
import type { GetServerSidePropsContext } from 'next';

type User = { id: string; admin: boolean; moved: boolean };

export async function getServerSideProps(ctx: GetServerSidePropsContext) {
  const user = await loadUser(ctx.req.cookies['session']);
  if (!user) throw redirect('/login');
  if (user.moved) throw redirect(`/u/${user.id}`, 308);
  requireAdmin(user);
  return { props: { user } };
}

export function requireAdmin(user: User) {
  if (!user.admin) throw redirect('/');
}

export const toHome = () => { throw redirect('/'); };

export default function Dashboard({ user }: { user: User }) {
  // TODO(gio-migrate): redirect() while rendering a component: GioJS redirects before the render - move this check into getServerSideProps (throw or return redirect(url)), or call navigate(url, { replace: true }) from @gio.js/react in the browser
  if (!user) throw redirect('/login');
  return <p>{user.id}</p>;
}

declare function loadUser(session: string | undefined): Promise<User | null>;
