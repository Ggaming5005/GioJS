// TODO(gio-migrate): next/cache: use export const revalidate = N on the page (and the on-demand revalidation API of @gio.js/core where available)
import { revalidatePath } from 'next/cache';

export async function generateStaticParams() {
  return [{ slug: 'hello' }];
}

// gio export pre-renders dynamic routes from getStaticPaths.
export async function getStaticPaths() {
  return { paths: (await generateStaticParams()).map((params) => ({ params })) };
}

// TODO(gio-migrate): async Server Components don't exist in GioJS (every page hydrates): move the awaited data loading into export async function getServerSideProps(ctx) and receive it as props
export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  // TODO(gio-migrate): Server Actions have no GioJS equivalent: move this into a route.ts handler (export async function POST(req)) and call it with fetch() or a <form method="post">
  async function save(formData: FormData) {
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
