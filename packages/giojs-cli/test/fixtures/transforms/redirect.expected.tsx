import { redirect } from '@gio.js/core';
// TODO(gio-migrate): types from 'next' (GetServerSidePropsContext) don't exist in GioJS: getServerSideProps receives { params, query, headers, cookies, locale }, route handlers a GioRequest (@gio.js/core), pages plain props
import type { GetServerSidePropsContext } from 'next';

type User = { id: string; admin: boolean; moved: boolean; friends: string[] };

export async function getServerSideProps(ctx: GetServerSidePropsContext) {
  const user = await loadUser(ctx.req.cookies['session']);
  if (!user) throw redirect('/login');
  if (user.moved) throw redirect(`/u/${user.id}`, 308);
  if (user.id === 'me') return redirect('/me');
  requireAdmin(user);
  const friends = await Promise.all(user.friends.map(async (id) => {
    const friend = await loadUser(id);
    if (!friend) throw redirect('/friends');
    return friend;
  }));
  return { props: { user, friends } };
}

export async function generateMetadata({ params }: { params: { id?: string } }) {
  if (!params.id) throw redirect('/posts');
  return { title: params.id };
}

export async function action(req: { formData(): Promise<FormData> }) {
  if (!(await req.formData()).get('id')) return redirect('/dashboard');
  return null;
}

export function requireAdmin(user: User) {
  if (!user.admin) throw redirect('/');
}

export async function requireUser(session: string | undefined) {
  const user = await loadUser(session);
  if (!user) throw redirect('/login');
  return user;
}

export function useRequireUser(user: User | null) {
  // TODO(gio-migrate): redirect() while rendering a component: GioJS redirects before the render - move this check into getServerSideProps (throw or return redirect(url)), or call navigate(url, { replace: true }) from @gio.js/react in the browser
  if (!user) throw redirect('/login');
}

export const toHome = () => { throw redirect('/'); };

export default function Dashboard({ user }: { user: User }) {
  // TODO(gio-migrate): redirect() while rendering a component: GioJS redirects before the render - move this check into getServerSideProps (throw or return redirect(url)), or call navigate(url, { replace: true }) from @gio.js/react in the browser
  if (!user) throw redirect('/login');
  return <p>{user.id}</p>;
}

declare function loadUser(session: string | undefined): Promise<User | null>;
