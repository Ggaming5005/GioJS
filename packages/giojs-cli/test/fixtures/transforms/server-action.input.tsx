import { revalidatePath } from 'next/cache';

export async function generateStaticParams() {
  return [{ slug: 'hello' }];
}

export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  async function save(formData: FormData) {
    'use server';
    await db.save(slug, formData.get('title'));
    revalidatePath(`/posts/${slug}`);
  }
  return (
    <form action={save}>
      <input name="title" />
    </form>
  );
}

declare const db: { save(slug: string, value: unknown): Promise<void> };
