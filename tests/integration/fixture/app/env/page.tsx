import React, { useEffect } from 'react';

export default function EnvPage() {
  useEffect(() => {
    // Non-public: must read as undefined in the browser, never be inlined.
    console.log(process.env.GIO_FIXTURE_PRIVATE);
  }, []);
  return <p>ENV_FIXTURE greeting={process.env.GIO_PUBLIC_FIXTURE_GREETING}</p>;
}
