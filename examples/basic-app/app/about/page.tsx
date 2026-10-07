import React from 'react';
import type { GetServerSideProps } from '@gio.js/core';

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

export const getServerSideProps: GetServerSideProps<AboutProps> = async (ctx) => {
  return { props: { locale: ctx.locale ?? 'en' } };
};
