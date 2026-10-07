'use client';
import NextLink, { type LinkProps } from 'next/link';
import Img from 'next/legacy/image';
import { GioFont } from '@gio.js/react';
import hero from '../public/hero.png';

type NavProps = LinkProps & { label: string };

export function Nav({ label, ...rest }: NavProps) {
  // <Link> in a comment and "next/link" in a string stay untouched.
  const note = "Don't use <Link legacyBehavior> here";
  return (
    <nav>
      <NextLink href="/about" legacyBehavior passHref>
        <a className="nav-link" onClick={() => console.log(note)}>
          About <strong>us</strong>
        </a>
      </NextLink>
      <NextLink href="/posts/[id]" as={`/posts/${label}`} prefetch shallow>
        {label}
      </NextLink>
      <NextLink href={{ pathname: '/search', query: { q: label } }} prefetch={false}>
        Search
      </NextLink>
      <NextLink {...rest}>Rest</NextLink>
      <Img src="/logo.png" layout="fill" objectFit="cover" alt="" />
      <Img src={hero} width={1200} height={600} layout="responsive" placeholder="blur" alt="Hero" />
      <Img src="/a.png" alt="a" width={10} height={10} loading="lazy" style={{ borderRadius: 4 }} />
      <GioFont family="Inter" />
    </nav>
  );
}
