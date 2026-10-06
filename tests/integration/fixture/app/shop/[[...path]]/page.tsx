import React from 'react';

// Optional catch-all: also answers the bare /shop, with an empty param.
export default function ShopOptionalCatchAll({ params }: { params: Record<string, string> }) {
  return <p>{`FIXTURE_OPTIONAL_CATCH_ALL path=[${params['path'] ?? ''}]`}</p>;
}
