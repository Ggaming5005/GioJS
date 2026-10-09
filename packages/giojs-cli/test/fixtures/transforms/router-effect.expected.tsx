import { useEffect, useState, useMemo } from 'react';
import { useSearchParams, useParams } from '@gio.js/react';

// Next keeps router.query's identity until the next navigation, so effects
// list it as a dependency; the migrated value must keep that identity too.
export default function Post() {
  const searchParams = useSearchParams();
  const routeParams = useParams();
  const routerQuery = useMemo(() => ({ ...Object.fromEntries(searchParams), ...routeParams }), [searchParams, routeParams]);
  const [data, setData] = useState(null);
  useEffect(() => {
    if (false) return;
    fetch('/api/' + routerQuery.id).then((r) => r.json()).then(setData);
  }, [true, routerQuery]);
  return <pre>{JSON.stringify(data)}</pre>;
}

export function Tabs({ params }: { params: string[] }) {
  const searchParams = useSearchParams();
  const routeParams = useParams();
  const query = useMemo(() => ({ ...Object.fromEntries(searchParams), ...routeParams }), [searchParams, routeParams]);
  useEffect(() => {
    console.log(params, query.tab);
  }, [query]);
  return null;
}
