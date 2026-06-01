import React from 'react';

const ALLOWED_WIDTHS = [16, 32, 48, 64, 96, 128, 256, 384, 640, 750, 828, 1080, 1200, 1920, 2048, 3840];

interface GioImageProps {
  src: string;
  width: number;
  height: number;
  alt: string;
  priority?: boolean;
  quality?: number;
  sizes?: string;
  fill?: boolean;
  className?: string;
  placeholder?: 'blur' | 'empty';
  blurDataURL?: string;
}

function nearestAllowedWidth(w: number): number {
  return ALLOWED_WIDTHS.reduce((prev, curr) =>
    Math.abs(curr - w) < Math.abs(prev - w) ? curr : prev
  );
}

function buildSrcSet(src: string, quality: number, widths: number[]): string {
  return widths
    .map((w) => `/_gio/image?src=${encodeURIComponent(src)}&w=${w}&q=${quality} ${w}w`)
    .join(', ');
}

/** Drop-in for next/image. Points to the /_gio/image optimisation endpoint. */
export function GioImage({
  src,
  width,
  height,
  alt,
  priority,
  quality = 75,
  sizes,
  fill,
  className,
  placeholder,
  blurDataURL,
}: GioImageProps): React.JSX.Element {
  const w = nearestAllowedWidth(width);
  const optimizedSrc = `/_gio/image?src=${encodeURIComponent(src)}&w=${w}&q=${quality}`;
  const srcSet =
    sizes !== undefined || fill === true
      ? buildSrcSet(src, quality, ALLOWED_WIDTHS.filter((aw) => fill === true || aw <= w))
      : undefined;

  const style = fill
    ? { objectFit: 'cover' as const, width: '100%', height: '100%' }
    : placeholder === 'blur' && blurDataURL !== undefined
    ? { backgroundImage: `url(${blurDataURL})`, backgroundSize: 'cover' as const }
    : undefined;

  return (
    <img
      src={optimizedSrc}
      srcSet={srcSet}
      width={fill ? undefined : width}
      height={fill ? undefined : height}
      alt={alt}
      sizes={sizes}
      fetchPriority={priority ? 'high' : undefined}
      className={className}
      style={style}
      loading={priority ? 'eager' : 'lazy'}
    />
  );
}
