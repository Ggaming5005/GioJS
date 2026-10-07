import { revalidatePath, revalidateTag } from '@gio.js/core';

// TODO(gio-migrate): unstable_cache removed: the function now runs on every call - GioJS caches whole pages in Rust instead: export const revalidate = N on the page, plus export const tags = [...] (or tags returned from getServerSideProps) for revalidateTag() (it had revalidate: 60, tags: ['posts'])
export const getPosts = async () => db.posts.list();

export async function getPost(id: string) {
  // TODO(gio-migrate): fetch() next: { revalidate: 30, tags: ['post'] }: Node's fetch has no data cache, so this does nothing in GioJS - GioJS caches whole pages in Rust instead: export const revalidate = N on the page, plus export const tags = [...] (or tags returned from getServerSideProps) for revalidateTag()
  const res = await fetch(`https://api.example.com/posts/${id}`, { next: { revalidate: 30, tags: ['post'] } });
  return res.json();
}

export async function publish(id: string) {
  await db.posts.publish(id);
  revalidatePath('/blog', { type: 'prefix' });
  revalidatePath(`/blog/${id}`);
  // TODO(gio-migrate): revalidatePath() purges a real path in GioJS ('/posts/1'), never a route pattern ('/posts/[id]'): pass the path itself, or the parent with { type: 'prefix' }
  revalidatePath('/blog/[slug]');
  // TODO(gio-migrate): revalidateTag() purges the pages that declare the tag: add export const tags = ['...'] (or return tags from getServerSideProps) to the pages this data appears on - fetch()'s next.tags means nothing to GioJS
  revalidateTag('posts');
}

declare const db: { posts: { list(): Promise<unknown[]>; publish(id: string): Promise<void> } };
