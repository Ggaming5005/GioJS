import React from 'react';
import Navbar from './Navbar';
import Footer from './Footer';

/**
 * The site's navigation, main column and footer. Rendered by
 * app/(site)/layout.jsx - inside the hydrated part of the page, so the
 * Navbar's GioLinks prefetch and soft-navigate (the root layout is
 * server-only HTML, where a GioLink is a plain link) - and by the 404 and
 * error pages, which sit outside that group.
 *
 * @param {{ children: import('react').ReactNode }} props
 */
export default function SiteShell({ children }) {
  return (
    <>
      <Navbar />
      <main>{children}</main>
      <Footer />
    </>
  );
}
