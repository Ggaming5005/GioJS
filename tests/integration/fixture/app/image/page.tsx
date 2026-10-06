import React from 'react';
import { GioImage } from '../../../../../packages/giojs-react/src/Image.tsx';

// Every srcset candidate must be a width gio.toml [images] allows - the
// optimizer answers 400 for anything else.
export default function ImagePage() {
  return (
    <main>
      <h1>IMAGE_FIXTURE</h1>
      <GioImage src="/gio-test.png" width={40} height={20} alt="fixed" priority />
      <GioImage src="/gio-test.png" width={120} height={60} alt="responsive" sizes="50vw" />
      <GioImage src="/gio-test.png" width={120} height={60} alt="plain" unoptimized />
    </main>
  );
}
