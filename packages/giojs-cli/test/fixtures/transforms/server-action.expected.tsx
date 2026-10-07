import { GioForm } from '@gio.js/react';
import { revalidatePath } from '@gio.js/core';

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
  // TODO(gio-migrate): Server Action: GioJS has no Server Actions - a form's action becomes the page's export async function action(req) (fields from await req.formData(); answer with redirect(url) or { status: 422, data } to re-render the page with an actionData prop) posted by <GioForm> from @gio.js/react; a non-form call becomes a route.ts handler (export async function POST(req)) called with fetch() - see "Server Actions" in MIGRATION_REPORT.md
  async function save(formData: FormData) {
    await db.save(slug, formData.get('title'));
    revalidatePath(`/posts/${slug}`);
  }
  // TODO(gio-migrate): <form action={save}> became <GioForm>, which posts to the page it is on: move save into that page's export async function action(req)
  return (
    <GioForm>
      <input name="title" />
    </GioForm>
  );
}

declare const db: { save(slug: string, value: unknown): Promise<void> };
