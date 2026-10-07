/** Types for highlight.mjs (plain JS so the tests run it without a compiler). */
export type Token = [className: string, text: string];
export function languageOf(lang: string | undefined): string | undefined;
export function tokenize(code: string, lang: string | undefined): Token[];
export function highlight(code: string, lang: string | undefined): string;
