import React from 'react';

export default function Footer(): React.JSX.Element {
  const year = new Date().getFullYear();
  return (
    <footer className="gio-footer">
      <div className="gio-container gio-footer__inner">
        <span className="gio-footer__copy">© {year} {{PROJECT_NAME}}</span>
        <div className="gio-footer__links">
          {/* External links are plain <a>: GioLink is for this app's own pages. */}
          <a href="https://giojs.com/docs" className="gio-footer__link">docs</a>
          <a href="https://github.com/Ggaming5005/GioJS" className="gio-footer__link">github</a>
        </div>
      </div>
    </footer>
  );
}
