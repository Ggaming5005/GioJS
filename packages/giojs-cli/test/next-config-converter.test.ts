/**
 * giojs-cli/test/next-config-converter.test.ts
 *
 * next.config → gio.toml: path syntax, redirects/rewrites/headers, images,
 * i18n, and the never-overwrite merge rules for an existing gio.toml.
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildToml, convertConfigSource, convertPath, mergeToml, planToml } from '../dist/next-config-converter.js';

const here = dirname(fileURLToPath(import.meta.url));

test('convertPath maps path-to-regexp syntax to gio.toml patterns', () => {
  assert.deepEqual(convertPath('/blog/:slug', 'source'), { path: '/blog/:slug' });
  assert.deepEqual(convertPath('/docs/:path*', 'source'), { path: '/docs/*path' });
  assert.deepEqual(convertPath('/', 'source'), { path: '/' });
  assert.deepEqual(convertPath('/a/:rest+', 'source'), {
    path: '/a/*rest',
    note: '":rest+" (one or more segments) became "*rest", which also matches zero segments',
  });
  for (const bad of ['/a/:id?', '/a/:id(\\d+)', '/a/(.*)/b', '/a/(\\d+)', '/post-:id', '/a/:path*/b', 'relative']) {
    assert.ok('error' in convertPath(bad, 'source'), bad);
  }
  assert.ok('error' in convertPath('https://example.com/:path*', 'destination'));
  assert.ok('error' in convertPath('/search?q=:q', 'destination'));
});

test('convertPath turns a trailing (.*) group into a catch-all', () => {
  // `/(.*)` matches every path including `/` in Next.js, exactly like `/*rest`.
  assert.deepEqual(convertPath('/(.*)', 'source'), { path: '/*rest' });
  assert.deepEqual(convertPath('/:path(.*)', 'source'), { path: '/*path' });
  // Below a prefix Next needs the slash: the prefix itself is the one extra match.
  assert.deepEqual(convertPath('/blog/(.*)', 'source'), {
    path: '/blog/*rest',
    note: '"(.*)" became "*rest", which also matches /blog itself (Next.js required something after the slash)',
  });
  assert.deepEqual(convertPath('/docs/:slug/:rest(.*)', 'source'), {
    path: '/docs/:slug/*rest',
    note: '":rest(.*)" became "*rest", which also matches /docs/:slug itself (Next.js required something after the slash)',
  });
  // An unnamed group never takes a name the path already captures.
  assert.deepEqual(convertPath('/:rest/(.*)', 'source'), {
    path: '/:rest/*rest2',
    note: '"(.*)" became "*rest2", which also matches /:rest itself (Next.js required something after the slash)',
  });
  // A named group can be referenced by a destination; an unnamed one cannot.
  assert.deepEqual(convertPath('/new/:path(.*)', 'destination'), { path: '/new/*path' });
  assert.ok('error' in convertPath('/new/(.*)', 'destination'));
});

test('the site-wide `/(.*)` headers rule and `(.*)` redirects convert instead of being skipped', () => {
  const config = convertConfigSource(`
const securityHeaders = [{ key: 'X-Frame-Options', value: 'DENY' }];
module.exports = {
  async headers() {
    return [
      { source: '/(.*)', headers: securityHeaders },
      { source: '/fonts/:file(.*)', headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }] },
    ];
  },
  async redirects() {
    return [
      { source: '/old/:path(.*)', destination: '/new/:path', permanent: true },
      { source: '/legacy/(.*)', destination: '/', permanent: false },
    ];
  },
};
`, 'next.config.js');
  assert.deepEqual(config.todos, []);
  assert.deepEqual(config.entries.map(e => [e.name, Object.fromEntries(e.keys), e.comments.length]), [
    ['headers', { path: '"/*rest"', headers: '{ "X-Frame-Options" = "DENY" }' }, 0],
    ['headers', { path: '"/fonts/*file"', headers: '{ "Cache-Control" = "public, max-age=31536000, immutable" }' }, 1],
    ['redirects', { from: '"/old/*path"', to: '"/new/:path"', status: '308' }, 1],
    ['redirects', { from: '"/legacy/*rest"', to: '"/"', status: '307' }, 1],
  ]);
});

test('a root catch-all rewrite is converted only when Next ran it before the filesystem too', () => {
  // Array-form (afterFiles) rewrites only reached paths no page or public file
  // matched; GioJS rewrites run before routing, so `/*rest` would take every request.
  const after = convertConfigSource("module.exports = { rewrites: async () => [{ source: '/(.*)', destination: '/index.html' }] };", 'next.config.js');
  assert.deepEqual(after.entries, []);
  assert.match(after.todos[0] ?? '', /^rewrite \/\(\.\*\) → \/index\.html skipped: Next\.js checked pages and public files before it, but GioJS rewrites run before routing, so \/\*rest would rewrite every request/);
  const before = convertConfigSource("module.exports = { rewrites: async () => ({ beforeFiles: [{ source: '/:path*', destination: '/maintenance' }] }) };", 'next.config.js');
  assert.deepEqual(before.todos, []);
  assert.deepEqual(before.entries.map(e => Object.fromEntries(e.keys)), [{ from: '"/*path"', to: '"/maintenance"' }]);
});

test('the legacy tests/fixtures next.config.js converts redirects, rewrites and images', async () => {
  const source = await readFile(join(here, '..', '..', '..', 'tests', 'fixtures', 'next.config.js'), 'utf8');
  const config = convertConfigSource(source, 'next.config.js');
  assert.deepEqual(config.entries.map(e => [e.name, Object.fromEntries(e.keys)]), [
    ['images.remote_patterns', { protocol: '"https"', hostname: '"cdn.example.com"', pathname: '"/images/*"' }],
    ['images.remote_patterns', { protocol: '"https"', hostname: '"**.cloudinary.com"' }],
    ['redirects', { from: '"/old-blog/:slug"', to: '"/blog/:slug"', status: '308' }],
    ['redirects', { from: '"/docs"', to: '"/documentation"', status: '307' }],
  ]);
  // The rewrite targets another host: skipped with a TODO, never approximated.
  assert.equal(config.todos.length, 1);
  assert.match(config.todos[0] ?? '', /rewrite \/api\/:path\* → http:\/\/internal-service:8080\/:path\* skipped: GioJS rewrites are internal/);
  assert.match(config.notes.join('\n'), /reactStrictMode/);
});

const RICH_CONFIG = `
const securityHeaders = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  basePath: '/app',
  trailingSlash: true,
  output: 'export',
  env: { API_URL: 'https://api.example.com' },
  webpack: (config) => config,
  i18n: { locales: ['en', 'de', 'fr'], defaultLocale: 'en', localeDetection: false },
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: 'img.example.com', port: '8443' },
      { hostname: '*.example.org', pathname: '/a/**/b' },
      { protocol: 'https', hostname: 'assets.example.com', pathname: '/uploads/*' },
    ],
    deviceSizes: [640, 1080, 1920],
    imageSizes: [16, 64, 640],
  },
  async headers() {
    return [
      { source: '/:path*', headers: securityHeaders },
      { source: '/api/:path*', has: [{ type: 'header', key: 'x-internal' }], headers: [{ key: 'X-Internal', value: '1' }] },
    ];
  },
  async redirects() {
    return [
      { source: '/home', destination: '/', permanent: true },
      { source: '/legacy/:id(\\\\d+)', destination: '/items/:id', permanent: false },
      { source: '/a', destination: '/b/:missing', permanent: false },
      { source: '/moved', destination: '/new', statusCode: 301 },
      { source: '/twitter', destination: 'https://twitter.com/giojs', permanent: false },
    ];
  },
  rewrites: async () => ({
    beforeFiles: [{ source: '/feed', destination: '/api/feed' }],
    afterFiles: [{ source: '/docs/:slug+', destination: '/documentation/:slug' }],
    fallback: [{ source: '/:path*', destination: '/legacy/:path*' }],
  }),
};

export default withBundleAnalyzer(nextConfig);
`;

test('a rich next.config converts every supported setting and flags the rest', () => {
  const config = convertConfigSource(RICH_CONFIG, 'next.config.mjs');
  const toml = buildToml(config, 'shop');
  assert.equal(toml, [
    '# gio.toml - generated by create-giojs migrate from next.config.',
    '# Reference: https://giojs.com/docs/configuration',
    '',
    '[app]',
    'name = "shop"',
    '',
    '[server]',
    'host = "0.0.0.0"',
    'port = 3000',
    'http2 = true',
    '',
    ...config.todos.map(t => `# TODO(gio-migrate): ${t}`),
    '',
    '[i18n]',
    'locales = ["en", "de", "fr"]',
    'default_locale = "en"',
    'detect_from = ["path"]',
    '',
    '[images]',
    'allowed_widths = [16, 64, 640, 1080, 1920]',
    '',
    '[[headers]]',
    'path = "/*path"',
    'headers = { "X-Frame-Options" = "DENY", "X-Content-Type-Options" = "nosniff" }',
    '',
    '[[redirects]]',
    'from = "/home"',
    'to = "/"',
    'status = 308',
    '',
    '[[redirects]]',
    'from = "/moved"',
    'to = "/new"',
    'status = 301',
    '',
    '[[rewrites]]',
    'from = "/feed"',
    'to = "/api/feed"',
    '',
    '# TODO(gio-migrate): ":slug+" (one or more segments) became "*slug", which also matches zero segments',
    '[[rewrites]]',
    'from = "/docs/*slug"',
    'to = "/documentation/:slug"',
    '',
  ].join('\n'));

  const todos = config.todos.join('\n');
  for (const expected of [
    /basePath "\/app"/,
    /trailingSlash: true/,
    /env: move these values to \.env/,
    /webpack: GioJS bundles with esbuild/,
    /remote image pattern img\.example\.com:8443 skipped: gio\.toml remote_patterns have no port/,
    /remote image pattern \*\.example\.org skipped: pathname "\/a\/\*\*\/b" uses a glob/,
    // One segment in Next.js; GioJS's `*` would let the image proxy fetch any depth.
    /remote image pattern assets\.example\.com skipped: pathname "\/uploads\/\*" allows one segment in Next\.js, but a gio\.toml "\*" matches at any depth/,
    /headers for \/api\/:path\* has has\/missing conditions/,
    /redirect \/legacy\/:id\(\\d\+\) → \/items\/:id skipped: segment ":id\(\\d\+\)" uses a regex/,
    /redirect \/a → \/b\/:missing skipped: the destination uses :missing, which the source doesn't capture/,
    /redirect \/twitter → https:\/\/twitter\.com\/giojs skipped: external destination/,
    /1 fallback rewrite\(s\) skipped/,
  ]) {
    assert.match(todos, expected);
  }
  assert.equal(config.staticExport, true);
  assert.deepEqual(config.envKeys, ['API_URL']);
  assert.match(config.notes.join('\n'), /wrapped in withBundleAnalyzer/);
});

test('experimental flags GioJS has its own form of point at it; the rest are listed', () => {
  const config = convertConfigSource(
    "export default { typedRoutes: true, experimental: { serverActions: { bodySizeLimit: '5mb' }, ppr: 'incremental', typedRoutes: true, optimizeCss: true, scrollRestoration: true } };",
    'next.config.mjs',
  );
  assert.deepEqual(config.todos, [
    'experimental.serverActions: Server Actions become page actions (export async function action) posted by <GioForm> - see the TODOs in the code; bodySizeLimit → gio.toml [server] max_body_bytes, allowedOrigins → [security.csrf] trusted_origins',
    "experimental.ppr: partial prerendering is per page in GioJS - export const shell = 'cache' next to export const revalidate on the pages that should serve a cached shell",
    'experimental: optimizeCss, scrollRestoration - no GioJS equivalent',
  ]);
  assert.deepEqual(config.notes, [
    'typedRoutes: GioJS always generates typed routes (.gio/routes.d.ts, used by href() from @gio.js/react)',
    'experimental.typedRoutes: GioJS always generates typed routes (.gio/routes.d.ts, used by href() from @gio.js/react)',
  ]);
});

test('a config that cannot be read statically produces a TODO, not a guess', () => {
  const config = convertConfigSource("module.exports = require('./config.json');\n", 'next.config.js');
  assert.deepEqual(config.entries, []);
  assert.match(config.todos[0] ?? '', /convert it by hand/);
});

test('mergeToml appends new tables and inserts keys into existing ones', () => {
  const existing = '[app]\nname = "x"\n\n[images]\nquality = 80\n\n[server]\nhost = "0.0.0.0"\nport = 3000\n';
  const config = convertConfigSource(
    "module.exports = { images: { deviceSizes: [640], domains: ['a.com'] }, i18n: { locales: ['en'], defaultLocale: 'en' }, redirects: async () => [{ source: '/a', destination: '/b', permanent: true }] };",
    'next.config.js',
  );
  const merged = mergeToml(existing, config);
  assert.ok('content' in merged);
  assert.equal(merged.content, [
    '[app]',
    'name = "x"',
    '',
    '[images]',
    'allowed_widths = [640]',
    'quality = 80',
    '',
    '[server]',
    'host = "0.0.0.0"',
    'port = 3000',
    '',
    '# ── Migrated from Next.js by create-giojs migrate (keys added to existing tables are listed in MIGRATION_REPORT.md) ──',
    '',
    '[i18n]',
    'locales = ["en"]',
    'default_locale = "en"',
    '',
    '[[images.remote_patterns]]',
    'protocol = "https"',
    'hostname = "a.com"',
    '',
    '[[redirects]]',
    'from = "/a"',
    'to = "/b"',
    'status = 308',
    '',
  ].join('\n'));
});

test('mergeToml refuses to define a key or table twice', () => {
  const config = convertConfigSource("module.exports = { images: { deviceSizes: [640] }, i18n: { locales: ['en'] } };", 'next.config.js');
  const clash = mergeToml('[images]\nallowed_widths = [100]\n', config);
  assert.deepEqual(clash, { conflict: 'gio.toml already sets [images] allowed_widths' });
  const inline = mergeToml('i18n = { locales = ["de"] }\n', config);
  assert.ok('conflict' in inline);
  const patterns = convertConfigSource("module.exports = { images: { domains: ['a.com'] } };", 'next.config.js');
  assert.ok('conflict' in mergeToml('[images]\nremote_patterns = []\n', patterns));
  const redirects = convertConfigSource("module.exports = { redirects: async () => [{ source: '/a', destination: '/b' }] };", 'next.config.js');
  assert.ok('conflict' in mergeToml('redirects = []\n', redirects));
});

test('planToml never overwrites: it creates, merges, or writes gio.migrated.toml', () => {
  const config = convertConfigSource("module.exports = { images: { deviceSizes: [640] } };", 'next.config.js');
  assert.equal(planToml(undefined, config, 'app').mode, 'created');
  const merged = planToml('[server]\nhost = "0.0.0.0"\nport = 3000\n', config, 'app');
  assert.equal(merged.mode, 'merged');
  assert.ok(merged.content.startsWith('[server]\nhost = "0.0.0.0"\nport = 3000\n'));
  const separate = planToml('[images]\nallowed_widths = [1]\n', config, 'app');
  assert.equal(separate.mode, 'separate');
  assert.equal(separate.target, 'gio.migrated.toml');
  assert.match(separate.content, /gio\.toml already sets \[images\] allowed_widths/);
  assert.match(separate.content, /\[images\]\nallowed_widths = \[640\]/);
  // A second migration never merges twice.
  assert.equal(planToml(merged.content, config, 'app').mode, 'separate');
});
