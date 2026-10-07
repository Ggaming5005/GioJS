import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';

// Next keeps router.query's identity until the next navigation, so effects
// list it as a dependency; the migrated value must keep that identity too.
export default function Post() {
  const router = useRouter();
  const [data, setData] = useState(null);
  useEffect(() => {
    if (!router.isReady) return;
    fetch('/api/' + router.query.id).then((r) => r.json()).then(setData);
  }, [router.isReady, router.query]);
  return <pre>{JSON.stringify(data)}</pre>;
}

export function Tabs({ params }: { params: string[] }) {
  const { query } = useRouter();
  useEffect(() => {
    console.log(params, query.tab);
  }, [query]);
  return null;
}
