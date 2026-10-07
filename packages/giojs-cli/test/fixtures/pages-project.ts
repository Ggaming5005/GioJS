/**
 * A small but complete Next.js pages-router project, written to a temp dir
 * by the migration tests.
 */
export const pagesProject: Record<string, string> = {
  'package.json': JSON.stringify({
    name: 'next-blog',
    private: true,
    scripts: { dev: 'next dev', build: 'next build', start: 'next start', lint: 'next lint' },
    dependencies: { next: '14.2.3', react: '18.2.0', 'react-dom': '18.2.0' },
    devDependencies: { typescript: '^5.4.0', '@types/react': '18.2.0', 'eslint-config-next': '14.2.3' },
  }, null, 2) + '\n',
  'tsconfig.json': JSON.stringify({
    compilerOptions: { target: 'es5', lib: ['dom', 'dom.iterable', 'esnext'], jsx: 'preserve', strict: true, plugins: [{ name: 'next' }], paths: { '@/*': ['./*'] } },
    include: ['next-env.d.ts', '**/*.ts', '**/*.tsx', '.next/types/**/*.ts'],
    exclude: ['node_modules'],
  }, null, 2) + '\n',
  'next-env.d.ts': '/// <reference types="next" />\n',
  'next.config.js': `/** @type {import('next').NextConfig} */
module.exports = {
  reactStrictMode: true,
  images: { domains: ['images.example.com'] },
  async redirects() {
    return [{ source: '/old/:path*', destination: '/new/:path*', permanent: true }];
  },
};
`,
  'pages/_app.tsx': `import type { AppProps } from 'next/app';
import '../styles/globals.css';
import { ThemeProvider } from '../components/theme';

export default function App({ Component, pageProps }: AppProps) {
  return (
    <ThemeProvider>
      <Component {...pageProps} />
    </ThemeProvider>
  );
}
`,
  'pages/_document.tsx': `import { Html, Head, Main, NextScript } from 'next/document';

export default function Document() {
  return (
    <Html lang="de">
      <Head>
        <link rel="icon" href="/favicon.ico" />
      </Head>
      <body className="antialiased">
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}
`,
  'pages/index.tsx': `import Head from 'next/head';
import Link from 'next/link';
import { Layout } from '../components/Layout';

export default function Home() {
  return (
    <Layout>
      <Head>
        <title>Home</title>
      </Head>
      <Link href="/about">About</Link>
    </Layout>
  );
}
`,
  'pages/about.tsx': `export default function About() {
  return <p>About</p>;
}
`,
  'pages/blog/[slug].tsx': `import { Layout } from '../../components/Layout';
import { getPost } from '../../lib/posts';

export default function Post({ title }: { title: string }) {
  return <Layout>{title}</Layout>;
}

export async function getStaticProps({ params }: { params: { slug: string } }) {
  return { props: getPost(params.slug), revalidate: 60 };
}

export async function getStaticPaths() {
  return { paths: [{ params: { slug: 'hello' } }], fallback: false };
}
`,
  'pages/docs/[...slug].tsx': `export default function Docs() {
  return <p>Docs</p>;
}
`,
  'pages/404.tsx': `export default function NotFound() {
  return <h1>Not found</h1>;
}
`,
  'pages/500.tsx': `export default function ServerError() {
  return <h1>Error</h1>;
}
`,
  'pages/api/hello.ts': `import type { NextApiRequest, NextApiResponse } from 'next';

export default function handler(_req: NextApiRequest, res: NextApiResponse) {
  res.status(200).json({ name: 'John Doe' });
}
`,
  'pages/api/users/[id].ts': `export default function handler(req, res) {
  res.json({ id: req.query.id });
}
`,
  'components/Layout.tsx': `import Link from 'next/link';

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <main>
      <Link href="/">Home</Link>
      {children}
    </main>
  );
}
`,
  'components/theme.tsx': `export function ThemeProvider({ children }: { children: React.ReactNode }) {
  return <div className="theme">{children}</div>;
}
`,
  'lib/posts.ts': `export function getPost(slug: string) {
  return { title: slug };
}
`,
  'styles/globals.css': 'body { margin: 0; }\n',
  'middleware.ts': `import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export function middleware(request: NextRequest) {
  return NextResponse.redirect(new URL('/login', request.url));
}
`,
  'public/robots.txt': 'User-agent: *\n',
};
