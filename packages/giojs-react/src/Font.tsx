/**
 * packages/giojs-react/src/Font.tsx
 *
 * Declarative font registration. No runtime output — the server reads
 * [[fonts]] from gio.toml and injects preload + @font-face CSS into <head>.
 * This component exists as a typed marker for tooling; it renders nothing.
 */

interface GioFontProps {
  family: string;
  weights?: number[];
}

export function GioFont(_props: GioFontProps): null {
  return null;
}
