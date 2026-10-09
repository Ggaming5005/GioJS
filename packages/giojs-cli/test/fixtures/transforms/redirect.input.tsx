import { redirect, permanentRedirect, RedirectType } from 'next/navigation';
import type { GetServerSidePropsContext } from 'next';

type User = { id: string; admin: boolean; moved: boolean; friends: string[] };

export async function getServerSideProps(ctx: GetServerSidePropsContext) {
  const user = await loadUser(ctx.req.cookies['session']);
  if (!user) redirect('/login');
  if (user.moved) permanentRedirect(`/u/${user.id}`, RedirectType.replace);
  if (user.id === 'me') return redirect('/me');
  requireAdmin(user);
  const friends = await Promise.all(user.friends.map(async (id) => {
    const friend = await loadUser(id);
    if (!friend) return redirect('/friends');
    return friend;
  }));
  return { props: { user, friends } };
}

export async function generateMetadata({ params }: { params: { id?: string } }) {
  if (!params.id) return redirect('/posts');
  return { title: params.id };
}

export async function action(req: { formData(): Promise<FormData> }) {
  if (!(await req.formData()).get('id')) return redirect('/dashboard');
  return null;
}

export function requireAdmin(user: User) {
  if (!user.admin) redirect('/');
}

export async function requireUser(session: string | undefined) {
  const user = await loadUser(session);
  if (!user) return redirect('/login');
  return user;
}

export function useRequireUser(user: User | null) {
  if (!user) redirect('/login');
}

export const toHome = () => redirect('/');

export default function Dashboard({ user }: { user: User }) {
  if (!user) redirect('/login');
  return <p>{user.id}</p>;
}

declare function loadUser(session: string | undefined): Promise<User | null>;
