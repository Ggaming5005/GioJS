/**
 * packages/giojs-react/src/Image.test.tsx
 *
 * GioImage must only request widths the optimizer accepts (gio.toml
 * allowed_widths - any other width is a 400), render plain src where there
 * is no optimizer (static export) or none is wanted, and preload priority
 * images.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { GioImage } from './Image.tsx';

const TEMPLATE_CONFIG = { widths: [640, 828, 1080, 1200, 1920], quality: 80, unoptimized: false };

function install(config: unknown): void {
  (globalThis as Record<string, unknown>)['__GIO_IMAGES__'] = config;
}

function attr(html: string, name: string): string | undefined {
  const match = html.match(new RegExp(`<img[^>]*\\s${name}="([^"]*)"`));
  return match?.[1]?.replace(/&amp;/g, '&');
}

/** Width (`w=`) of every URL in a srcset or src attribute. */
function widthsOf(value: string | undefined): number[] {
  return [...(value ?? '').matchAll(/[?&]w=(\d+)/g)].map((m) => Number(m[1]));
}

describe('GioImage', () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>)['__GIO_IMAGES__'];
  });

  it('sizes: srcset offers exactly the configured widths at the configured quality', () => {
    install(TEMPLATE_CONFIG);
    const html = renderToString(
      <GioImage src="/hero.jpg" width={1200} height={600} alt="" sizes="(max-width: 800px) 100vw, 50vw" />,
    );
    const srcSet = attr(html, 'srcSet');
    expect(widthsOf(srcSet)).toEqual([640, 828, 1080, 1200, 1920]);
    expect(srcSet).toContain('/_gio/image?src=%2Fhero.jpg&w=640&q=80 640w');
    expect(srcSet).not.toMatch(/q=75/);
    expect(attr(html, 'sizes')).toBe('(max-width: 800px) 100vw, 50vw');
    expect(widthsOf(attr(html, 'src'))).toEqual([1920]);
  });

  it('fixed size: 1x/2x candidates snap up to allowed widths only', () => {
    install(TEMPLATE_CONFIG);
    const html = renderToString(<GioImage src="/a.png" width={500} height={300} alt="a" />);
    const srcSet = attr(html, 'srcSet') ?? '';
    // 500 -> 640 (1x), 1000 -> 1080 (2x); the old hardcoded list said 384/1080.
    expect(srcSet).toBe('/_gio/image?src=%2Fa.png&w=640&q=80 1x, /_gio/image?src=%2Fa.png&w=1080&q=80 2x');
    for (const w of [...widthsOf(srcSet), ...widthsOf(attr(html, 'src'))]) {
      expect(TEMPLATE_CONFIG.widths).toContain(w);
    }
    expect(attr(html, 'sizes')).toBeUndefined();
    expect(attr(html, 'width')).toBe('500');
  });

  it('widths beyond the largest allowed one use the largest', () => {
    install(TEMPLATE_CONFIG);
    const html = renderToString(<GioImage src="/a.png" width={1900} height={300} alt="" />);
    expect(widthsOf(attr(html, 'srcSet'))).toEqual([1920]);
  });

  it('fill defaults sizes to 100vw', () => {
    install(TEMPLATE_CONFIG);
    const html = renderToString(<GioImage src="/a.png" width={10} height={10} alt="" fill />);
    expect(attr(html, 'sizes')).toBe('100vw');
    expect(widthsOf(attr(html, 'srcSet'))).toEqual(TEMPLATE_CONFIG.widths);
    expect(attr(html, 'width')).toBeUndefined();
  });

  it('falls back to the optimizer defaults without an installed config', () => {
    const html = renderToString(<GioImage src="/a.png" width={100} height={100} alt="" />);
    expect(attr(html, 'srcSet')).toBe('/_gio/image?src=%2Fa.png&w=128&q=75 1x, /_gio/image?src=%2Fa.png&w=256&q=75 2x');
  });

  it('an explicit quality is clamped to what the optimizer accepts', () => {
    install(TEMPLATE_CONFIG);
    const html = renderToString(<GioImage src="/a.png" width={640} height={1} alt="" quality={150} />);
    expect(attr(html, 'src')).toMatch(/&q=100$/);
  });

  it('an empty allowed_widths list requests no width at all', () => {
    install({ widths: [], quality: 75, unoptimized: false });
    const html = renderToString(<GioImage src="/a.png" width={640} height={1} alt="" sizes="100vw" />);
    expect(attr(html, 'src')).toBe('/_gio/image?src=%2Fa.png&q=75');
    expect(attr(html, 'srcSet')).toBeUndefined();
  });

  it('unoptimized renders the plain src', () => {
    install(TEMPLATE_CONFIG);
    const html = renderToString(
      <GioImage src="/a.png" width={640} height={480} alt="" sizes="100vw" unoptimized />,
    );
    expect(attr(html, 'src')).toBe('/a.png');
    expect(attr(html, 'srcSet')).toBeUndefined();
    expect(attr(html, 'sizes')).toBeUndefined();
    expect(attr(html, 'width')).toBe('640');
  });

  it('static export (no optimizer) renders every image with its plain src', () => {
    install({ ...TEMPLATE_CONFIG, unoptimized: true });
    const html = renderToString(
      <GioImage src="https://images.example.com/a.jpg" width={640} height={480} alt="" sizes="50vw" />,
    );
    expect(attr(html, 'src')).toBe('https://images.example.com/a.jpg');
    expect(html).not.toContain('/_gio/image');
  });

  it('SVG, data: and blob: sources skip the optimizer', () => {
    install(TEMPLATE_CONFIG);
    for (const src of ['/logo.svg', '/logo.SVG?v=2', 'data:image/png;base64,AAAA', 'blob:https://x/y']) {
      const html = renderToString(<GioImage src={src} width={64} height={64} alt="" />);
      expect(html).not.toContain('/_gio/image');
    }
  });

  it('priority loads eagerly and is preloaded in the document head', () => {
    install(TEMPLATE_CONFIG);
    const html = renderToString(
      <html>
        <head />
        <body>
          <GioImage src="/hero.jpg" width={640} height={480} alt="" sizes="100vw" priority />
        </body>
      </html>,
    );
    const head = html.slice(0, html.indexOf('</head>'));
    expect(head).toMatch(/<link rel="preload" as="image"[^>]*imageSrcSet="[^"]*w=640[^"]*"[^>]*imageSizes="100vw"/);
    expect(head).toContain('fetchPriority="high"');
    expect(attr(html, 'loading')).toBe('eager');
    expect(attr(html, 'fetchPriority')).toBe('high');
  });

  it('non-priority images are lazy and never preloaded', () => {
    install(TEMPLATE_CONFIG);
    const html = renderToString(
      <html>
        <head />
        <body>
          <GioImage src="/a.jpg" width={640} height={480} alt="" />
        </body>
      </html>,
    );
    expect(html).not.toContain('rel="preload"');
    expect(attr(html, 'loading')).toBe('lazy');
  });

  it('a priority unoptimized image preloads its plain src', () => {
    install({ ...TEMPLATE_CONFIG, unoptimized: true });
    const html = renderToString(
      <html>
        <head />
        <body>
          <GioImage src="/hero.jpg" width={640} height={480} alt="" priority />
        </body>
      </html>,
    );
    expect(html).toContain('<link rel="preload" as="image" href="/hero.jpg" fetchPriority="high"/>');
  });
});
