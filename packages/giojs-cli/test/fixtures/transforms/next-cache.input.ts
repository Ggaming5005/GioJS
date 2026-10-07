import { revalidatePath, revalidateTag, unstable_cache, unstable_noStore as noStore } from 'next/cache';

export const getPosts = unstable_cache(async () => db.posts.list(), ['posts'], { revalidate: 60, tags: ['posts'] });

export async function getPost(id: string) {
  noStore();
  const res = await fetch(`https://api.example.com/posts/${id}`, { next: { revalidate: 30, tags: ['post'] } });
  return res.json();
}

export async function publish(id: string) {
  await db.posts.publish(id);
  revalidatePath('/blog', 'layout');
  revalidatePath(`/blog/${id}`, 'page');
  revalidatePath('/blog/[slug]', 'page');
  revalidateTag('posts');
}

declare const db: { posts: { list(): Promise<unknown[]>; publish(id: string): Promise<void> } };
