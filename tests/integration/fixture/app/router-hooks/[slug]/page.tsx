import React from 'react';
import {
  useParams,
  usePathname,
  useSearchParams,
} from '../../../../../../packages/giojs-react/src/hooks/useNavigation.ts';

export default function RouterHooks() {
  const pathname = usePathname();
  const { slug } = useParams<{ slug: string }>();
  const searchParams = useSearchParams();
  return (
    <main>
      <p>{`ROUTER_HOOKS_PAGE pathname=[${pathname}] slug=[${slug}] q=[${searchParams.get('q') ?? ''}]`}</p>
    </main>
  );
}
