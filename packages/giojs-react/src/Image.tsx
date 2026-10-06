/**
 * packages/giojs-react/src/Image.tsx
 *
 * Drop-in replacement for next/image. Points src/srcSet at the /_gio/image
 * optimisation endpoint served by giojs-image (Rust), using exactly the
 * widths gio.toml's [images] allowed_widths permits - the optimizer answers
 * 400 for any other width. The GioJS worker installs that config for the
 * server render and the hydration envelope carries it to the browser, so
 * both render identical srcsets.
 *
 * Plain `src` (no optimizer) when there is none to point at - static export
 * (`gio export`) - or when asked (`unoptimized`), and for sources it cannot
 * process: SVG, data: and blob: URLs. `priority` loads eagerly with high
 * fetch priority, which React 19's server renderer turns into a
 * `<link rel="preload" as="image">` in the document head.
 */
import React from 'react';

/** Mirrors the Rust [images] defaults (allowed_widths, quality). */
const DEFAULT_WIDTHS: readonly number[] = [
  16, 32, 48, 64, 96, 128, 256, 384, 640, 750, 828, 1080, 1200, 1920, 2048, 3840,
];
const DEFAULT_QUALITY = 75;

/** The `[images]` settings the page renders with (core's image-config.ts). */
interface ImageRenderConfig {
  widths: readonly number[];
  quality: number;
  unoptimized: boolean;
}

interface GioImageProps {
  src: string;
  width: number;
  height: number;
  alt: string;
  /** Above-the-fold image: eager, high fetch priority, preloaded. */
  priority?: boolean;
  /** 1-100; defaults to gio.toml [images] quality. */
  quality?: number;
  /** Rendered width per breakpoint; switches the srcset to width descriptors. */
  sizes?: string;
  fill?: boolean;
  className?: string;
  placeholder?: 'blur' | 'empty';
  blurDataURL?: string;
  /** Skip the optimizer and render `src` as-is. */
  unoptimized?: boolean;
}

/**
 * The config installed on globalThis.__GIO_IMAGES__ by the GioJS worker
 * (server) or the hydration runtime (browser); the optimizer defaults when
 * absent or malformed.
 */
function readImageConfig(): ImageRenderConfig {
  const installed = (globalThis as { __GIO_IMAGES__?: unknown }).__GIO_IMAGES__;
  const fallback = { widths: DEFAULT_WIDTHS, quality: DEFAULT_QUALITY, unoptimized: false };
  if (typeof installed !== 'object' || installed === null) return fallback;
  const config = installed as Record<string, unknown>;
  const widths = config['widths'];
  const quality = config['quality'];
  return {
    widths: Array.isArray(widths)
      ? widths.filter((w): w is number => Number.isInteger(w) && w > 0)
      : fallback.widths,
    quality: typeof quality === 'number' ? quality : fallback.quality,
    unoptimized: config['unoptimized'] === true,
  };
}

/** Sources the optimizer cannot fetch or rasterize. */
function isUnoptimizable(src: string): boolean {
  if (/^(?:data|blob):/i.test(src)) return true;
  return /\.svg$/i.test(src.split(/[?#]/)[0] ?? '');
}

/** The optimizer only accepts integer qualities 1-100. */
function clampQuality(quality: number): number {
  return Math.min(100, Math.max(1, Math.round(quality)));
}

function optimizedUrl(src: string, width: number | undefined, quality: number): string {
  const w = width === undefined ? '' : `&w=${width}`;
  return `/_gio/image?src=${encodeURIComponent(src)}${w}&q=${quality}`;
}

/** Smallest allowed width covering `target`, or the largest there is. */
function snapUp(target: number, widths: readonly number[]): number | undefined {
  return widths.find((w) => w >= target) ?? widths[widths.length - 1];
}

interface Sources {
  src: string;
  srcSet?: string;
  sizes?: string;
}

function optimizedSources(
  src: string,
  width: number,
  quality: number,
  sizes: string | undefined,
  fill: boolean,
  widths: readonly number[],
): Sources {
  const sorted = [...new Set(widths)].sort((a, b) => a - b);
  if (sorted.length === 0) {
    // No width may be requested at all: format conversion only.
    return { src: optimizedUrl(src, undefined, quality) };
  }
  if (sizes !== undefined || fill) {
    // Rendered width unknown until layout: offer every allowed width.
    const srcSet = sorted.map((w) => `${optimizedUrl(src, w, quality)} ${w}w`).join(', ');
    const largest = sorted[sorted.length - 1];
    return { src: optimizedUrl(src, largest, quality), srcSet, sizes: sizes ?? '100vw' };
  }
  if (!(width > 0)) return { src: optimizedUrl(src, undefined, quality) };
  // Fixed size: 1x and 2x (high-DPI) candidates.
  const oneX = snapUp(width, sorted);
  const twoX = snapUp(width * 2, sorted);
  const candidates = [`${optimizedUrl(src, oneX, quality)} 1x`];
  if (twoX !== oneX) candidates.push(`${optimizedUrl(src, twoX, quality)} 2x`);
  return { src: optimizedUrl(src, twoX, quality), srcSet: candidates.join(', ') };
}

/** Drop-in for next/image. Points to the /_gio/image optimisation endpoint. */
export function GioImage({
  src,
  width,
  height,
  alt,
  priority,
  quality,
  sizes,
  fill,
  className,
  placeholder,
  blurDataURL,
  unoptimized,
}: GioImageProps): React.JSX.Element {
  const config = readImageConfig();
  const plain = unoptimized === true || config.unoptimized || isUnoptimizable(src);
  const sources: Sources = plain
    ? { src }
    : optimizedSources(
        src,
        width,
        clampQuality(quality ?? config.quality),
        sizes,
        fill === true,
        config.widths,
      );

  const blur = placeholder === 'blur' && blurDataURL !== undefined;
  const style =
    fill || blur
      ? {
          ...(fill ? { objectFit: 'cover' as const, width: '100%', height: '100%' } : {}),
          ...(blur ? { backgroundImage: `url(${blurDataURL})`, backgroundSize: 'cover' as const } : {}),
        }
      : undefined;

  return (
    <img
      src={sources.src}
      srcSet={sources.srcSet}
      sizes={sources.srcSet !== undefined ? sources.sizes : undefined}
      width={fill ? undefined : width}
      height={fill ? undefined : height}
      alt={alt}
      {...(priority ? { fetchPriority: 'high' as const } : {})}
      className={className}
      style={style}
      loading={priority ? 'eager' : 'lazy'}
    />
  );
}
