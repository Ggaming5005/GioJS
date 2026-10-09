/**
 * The demo login: a single user whose credentials come from DEMO_EMAIL and
 * DEMO_PASSWORD (set in .env.development for `npm run dev`). Before going
 * live, replace verifyCredentials with a lookup in your user store and a
 * password-hash check (node:crypto's scrypt, for one).
 */
import { createHash, timingSafeEqual } from 'node:crypto';

/** Constant-time string comparison (hashing first makes the lengths equal). */
function safeEqual(a: string, b: string): boolean {
  const digest = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();
  return timingSafeEqual(digest(a), digest(b));
}

export function verifyCredentials(email: string, password: string): boolean {
  const expectedEmail = process.env.DEMO_EMAIL ?? '';
  const expectedPassword = process.env.DEMO_PASSWORD ?? '';
  // Unset credentials match nothing: no accidental demo login in production.
  if (expectedEmail === '' || expectedPassword === '') return false;
  // Both are always compared, so the timing never tells which one was wrong.
  const emailMatches = safeEqual(email.trim().toLowerCase(), expectedEmail.trim().toLowerCase());
  const passwordMatches = safeEqual(password, expectedPassword);
  return emailMatches && passwordMatches;
}
