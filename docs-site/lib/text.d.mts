/** Types for text.mjs (plain JS so build.mjs and the tests run it without a compiler). */
export function decodeEntities(text: string): string;
export function articleHtml(html: string): string;
export function stripNonText(html: string): string;
export function stripTags(html: string): string;
export function htmlToText(html: string): string;
export function htmlToPlain(html: string): string;
export function slugify(text: string): string;
export function uniqueSlug(text: string, taken: Set<string>): string;
