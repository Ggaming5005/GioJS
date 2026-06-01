import React from 'react';
import { GioLink } from '@gio.js/react';

export default function Footer(): React.JSX.Element {
  const year = new Date().getFullYear();
  return (
    <footer className="gio-footer">
      <div className="gio-container gio-footer__inner">
        <span className="gio-footer__copy">© {year} {{PROJECT_NAME}}</span>
        <div className="gio-footer__links">
          <GioLink href="/_gio/health" className="gio-footer__link">health</GioLink>
          <GioLink href="/_gio/metrics" className="gio-footer__link">metrics</GioLink>
        </div>
      </div>
    </footer>
  );
}
