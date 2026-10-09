// @vitest-environment node
/**
 * packages/giojs-react/src/navigation-server.test.ts
 *
 * The navigation module during server rendering, where there is no
 * `window`: importing it and calling its exported helpers must never throw
 * (a component may call them while it renders on the server).
 */
import { describe, it, expect } from 'vitest';
import {
  getDeploymentId,
  handleHardReload,
  initDeploymentId,
  isHardReloadResponse,
} from './navigation.ts';

describe('navigation helpers without a window', () => {
  it('runs on the server: no window, no throw', () => {
    expect(typeof window).toBe('undefined');
    expect(() => initDeploymentId()).not.toThrow();
    expect(getDeploymentId()).toBeUndefined();
    expect(isHardReloadResponse(new Response(null, { status: 409, headers: { 'x-gio-action': 'hard-reload' } }))).toBe(true);
    expect(() => handleHardReload()).not.toThrow();
  });
});
