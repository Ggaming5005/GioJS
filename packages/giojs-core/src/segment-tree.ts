/**
 * giojs-core/src/segment-tree.ts
 *
 * The element tree inside the #__gio hydration boundary, built by ONE
 * function for both the server render (ssr.ts) and the generated client
 * entries (client-runtime.ts): hydration and useId both depend on the two
 * trees having exactly the same structure.
 *
 * Per folder, outermost first (Next.js App Router nesting): the folder's
 * layout, then its error boundary (error.*), then its loading boundary
 * (loading.*), then the next folder down, and finally the page. An error.*
 * therefore never catches its own folder's layout - the boundary above it
 * does - and a loading.* shows while anything below it suspends.
 *
 * Browser-safe: imports only React and not-found.ts.
 */
import React from 'react';
import { isNotFoundError } from './not-found.ts';

/** The failure an error.* component receives (the Next.js shape). */
export interface GioErrorInfo {
  /** Real message in development; generic in production. */
  message: string;
  /** Error reference the server logged the details under, when it came from the server. */
  digest?: string;
}

/**
 * Props of an error.* component. `reset` re-renders the failed segment; it
 * exists only when the error was caught in the browser - a server-rendered
 * 500 page is static HTML.
 */
export interface GioErrorProps {
  error: GioErrorInfo;
  reset?: () => void;
}

type LayoutComponent = React.ComponentType<{ children: React.ReactNode; path?: string }>;

/**
 * Observes a loading boundary on the server: `enter` runs when its content
 * starts rendering, `exit` once all of it has rendered or suspended. React
 * renders a boundary's content inline and moves past a suspended child, so
 * an entered-but-never-exited boundary is one whose content THREW before
 * suspending - what would have failed the shell without the boundary.
 * `after` runs once React has moved past the whole boundary (its next
 * sibling): React reports the error that aborted the content just before
 * that, so it is the last error reported when `after` runs.
 */
export interface LoadingProbe {
  enter(): void;
  exit(): void;
  after(): void;
}

/** One folder's contribution to the tree; folders with none of these are omitted. */
export interface SegmentLevel {
  /** null for app/ itself: the root layout stays server-only HTML outside #__gio. */
  layout?: LayoutComponent | null;
  error?: React.ComponentType<GioErrorProps> | null;
  loading?: React.ComponentType | null;
  /** Server only. */
  probe?: LoadingProbe;
}

/** What production shows for errors whose details must stay out of the page. */
const GENERIC_SERVER_MESSAGE = 'Internal Server Error';
const GENERIC_CLIENT_MESSAGE = 'Application Error';

/**
 * The `{ message, digest }` a client boundary hands to error.*. In production
 * every message is generic, matching what the server sends. A boundary the
 * server could not finish does not hand the server's error over: React
 * reports it (with the server's digest) to onRecoverableError and renders the
 * segment again in the browser, so a boundary only sees what that render
 * throws - an error object that carries a digest keeps it.
 */
export function publicErrorInfo(error: unknown): GioErrorInfo {
  if (isNotFoundError(error)) return { message: 'Not Found' };
  const rawDigest =
    typeof error === 'object' && error !== null
      ? (error as Record<string, unknown>)['digest']
      : undefined;
  const digest = typeof rawDigest === 'string' && rawDigest !== '' ? rawDigest : undefined;
  let message: string;
  if (process.env.NODE_ENV === 'development') {
    message = error instanceof Error ? error.message : String(error);
  } else {
    message = digest !== undefined ? GENERIC_SERVER_MESSAGE : GENERIC_CLIENT_MESSAGE;
  }
  return digest !== undefined ? { message, digest } : { message };
}

interface SegmentErrorBoundaryProps {
  fallback: React.ComponentType<GioErrorProps>;
  children?: React.ReactNode;
}

interface SegmentErrorBoundaryState {
  // Wrapped: a thrown value may itself be null or undefined.
  caught: { error: unknown } | null;
}

/**
 * Client error boundary for one folder's error.*. On the server it renders
 * its children unchanged (React has no server error boundaries) - ssr.ts
 * picks the error.* for a failed render itself.
 */
export class SegmentErrorBoundary extends React.Component<
  SegmentErrorBoundaryProps,
  SegmentErrorBoundaryState
> {
  override state: SegmentErrorBoundaryState = { caught: null };

  static getDerivedStateFromError(error: unknown): SegmentErrorBoundaryState {
    return { caught: { error } };
  }

  // Clearing the error remounts the children: the segment renders afresh.
  private readonly reset = (): void => {
    this.setState({ caught: null });
  };

  override render(): React.ReactNode {
    if (this.state.caught !== null) {
      return React.createElement(this.props.fallback, {
        error: publicErrorInfo(this.state.caught.error),
        reset: this.reset,
      });
    }
    return this.props.children;
  }
}

/** Renders the boundary content between the probe's enter and exit marks. */
function LoadingContent({
  probe,
  children,
}: {
  probe?: LoadingProbe | undefined;
  children?: React.ReactNode;
}): React.ReactNode {
  probe?.enter();
  return React.createElement(
    React.Fragment,
    null,
    children,
    React.createElement(LoadingContentEnd, { probe }),
  );
}

function LoadingContentEnd({ probe }: { probe?: LoadingProbe | undefined }): null {
  probe?.exit();
  return null;
}

/** Rendered right after the loading boundary; renders nothing on either side. */
function LoadingBoundaryEnd({ probe }: { probe?: LoadingProbe | undefined }): null {
  probe?.after();
  return null;
}

/**
 * The tree inside #__gio for `page`: each level wraps everything below it,
 * outermost level first in `levels`.
 */
export function buildSegmentTree(
  page: React.ReactNode,
  path: string,
  levels: readonly SegmentLevel[],
): React.ReactNode {
  let element = page;
  for (let i = levels.length - 1; i >= 0; i--) {
    const level = levels[i];
    if (level === undefined) continue;
    if (level.loading) {
      element = React.createElement(
        React.Fragment,
        null,
        React.createElement(
          React.Suspense,
          { fallback: React.createElement(level.loading) },
          React.createElement(LoadingContent, { probe: level.probe }, element),
        ),
        React.createElement(LoadingBoundaryEnd, { probe: level.probe }),
      );
    }
    if (level.error) {
      element = React.createElement(SegmentErrorBoundary, { fallback: level.error }, element);
    }
    if (level.layout) {
      element = React.createElement(level.layout, { children: element, path });
    }
  }
  return element;
}

/**
 * `tree` preceded by its route's stylesheets (css-build.ts) as React
 * stylesheet resources. React hoists them into <head> during SSR, adopts the
 * server's <link>s on hydration, and on a client render loads new ones
 * before revealing the tree. Resources take no position inside #__gio, so
 * they never shift hydration - but both sides still build them here.
 */
export function withStylesheets(tree: React.ReactNode, hrefs: readonly string[]): React.ReactNode {
  if (hrefs.length === 0) return tree;
  return React.createElement(
    React.Fragment,
    null,
    ...hrefs.map(href =>
      React.createElement('link', { key: href, rel: 'stylesheet', href, precedence: 'default' }),
    ),
    tree,
  );
}
