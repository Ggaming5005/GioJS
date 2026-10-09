import type { ComponentProps } from 'react';
import { GioFont, GioLink, GioImage } from '@gio.js/react';
// TODO(gio-migrate): static asset import '../public/hero.png': GioJS doesn't bundle assets - move the file under public/ and reference it by URL (public/x.png is served at /x.png)
import hero from '../public/hero.png';

type NavProps = ComponentProps<typeof GioLink> & { label: string };

export function Nav({ label, ...rest }: NavProps) {
  // <Link> in a comment and "next/link" in a string stay untouched.
  const note = "Don't use <Link legacyBehavior> here";
  // TODO(gio-migrate): GioLink doesn't take `onClick`: it accepts href, prefetch, replace, scroll, transition, className, target, download and aria-current
  // TODO(gio-migrate): shallow routing has no GioJS equivalent: this link now does a normal soft navigation
  // TODO(gio-migrate): GioLink needs a string href: replace the { pathname, query } object with a string (href('/posts/:id', { id }) from @gio.js/react builds typed ones)
  // TODO(gio-migrate): props spread into <GioLink>: it accepts href, prefetch, replace, scroll, transition, className, target, download and aria-current only
  // TODO(gio-migrate): legacy `objectFit` prop: GioImage has no style prop - set object-fit/object-position through className
  // TODO(gio-migrate): GioImage fill sizes the image to 100% of its parent (object-fit: cover), but width and height are still required props - pass the intrinsic size
  // TODO(gio-migrate): src={hero} is a static image import: move the file under public/ and pass its URL plus width and height
  // TODO(gio-migrate): GioImage doesn't take `style`
  return (
    <nav>
      <GioLink href="/about" className="nav-link" onClick={() => console.log(note)}>
        About <strong>us</strong>
      </GioLink>
      <GioLink href={`/posts/${label}`} prefetch="viewport">
        {label}
      </GioLink>
      <GioLink href={{ pathname: '/search', query: { q: label } }} prefetch={false}>
        Search
      </GioLink>
      <GioLink {...rest}>Rest</GioLink>
      <GioImage src="/logo.png" fill alt="" />
      <GioImage src={hero} width={1200} height={600} sizes="100vw" placeholder="blur" alt="Hero" />
      <GioImage src="/a.png" alt="a" width={10} height={10} style={{ borderRadius: 4 }} />
      <GioFont family="Inter" />
    </nav>
  );
}
