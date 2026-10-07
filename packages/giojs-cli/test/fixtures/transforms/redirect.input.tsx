import { redirect, permanentRedirect, RedirectType } from 'next/navigation';
import type { GetServerSidePropsContext } from 'next';

type User = { id: string; admin: boolean; moved: boolean };

export async function getServerSideProps(ctx: GetServerSidePropsContext) {
  const user = await loadUser(ctx.req.cookies['session']);
  if (!user) redirect('/login');
  if (user.moved) permanentRedirect(`/u/${user.id}`, RedirectType.replace);
  requireAdmin(user);
  return { props: { user } };
}

export function requireAdmin(user: User) {
  if (!user.admin) redirect('/');
}

export const toHome = () => redirect('/');

export default function Dashboard({ user }: { user: User }) {
  if (!user) redirect('/login');
  return <p>{user.id}</p>;
}

declare function loadUser(session: string | undefined): Promise<User | null>;
