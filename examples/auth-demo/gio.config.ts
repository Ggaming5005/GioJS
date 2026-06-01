import { authPlugin } from '../../packages/giojs-auth-example/src/index.ts';
import type { GioConfig } from '../../packages/giojs-core/src/config-loader.ts';

export default {
  plugins: [authPlugin],
} satisfies GioConfig;
