import React from 'react';
import { useParams, usePathname } from '../../../../../packages/giojs-react/src/hooks/useNavigation.ts';

export default function RouterHooksLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const params = useParams();
  return (
    <section>
      <p>{`ROUTER_HOOKS_LAYOUT pathname=[${pathname}] params=[${JSON.stringify(params)}]`}</p>
      {children}
    </section>
  );
}
