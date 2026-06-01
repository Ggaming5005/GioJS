import React from 'react';

interface AboutProps {
  locale: string;
}

const content: Record<string, { title: string; body: string }> = {
  en: { title: 'About Us', body: 'Welcome to GioJS.' },
  fr: { title: 'À propos', body: 'Bienvenue sur GioJS.' },
};

export default function AboutPage({ locale }: AboutProps): React.JSX.Element {
  const page = content[locale] ?? content['en']!;
  return (
    <main>
      <h1>{page.title}</h1>
      <p>{page.body}</p>
    </main>
  );
}

export async function getServerSideProps(ctx: {
  locale?: string;
  params: Record<string, string>;
  query: Record<string, string>;
}): Promise<AboutProps> {
  return { locale: ctx.locale ?? 'en' };
}
