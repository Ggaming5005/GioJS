import React from 'react';
import { GioLink } from '@gio.js/react';

const NAV_LINKS = [
  { href: '/', label: 'home' },
  { href: '/about', label: 'structure' },
  { href: '/posts/1', label: 'example' },
] as const;

export default function Navbar(): React.JSX.Element {
  return (
    <nav className="gio-nav" aria-label="Main navigation">
      <div className="gio-container gio-nav__inner">
        <GioLink href="/" className="gio-brand">
          <img className="gio-brand__mark" src="/public/giojs-logo.svg" alt="" width={26} height={26} />
          {{PROJECT_NAME}}
        </GioLink>

        <ul className="gio-nav__links" role="list">
          {NAV_LINKS.map(({ href, label }) => (
            <li key={href}>
              <GioLink href={href} className="gio-nav__link">{label}</GioLink>
            </li>
          ))}
        </ul>
      </div>
    </nav>
  );
}
