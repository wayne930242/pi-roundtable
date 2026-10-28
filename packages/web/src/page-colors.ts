/**
 * The page's background in each look and scheme, which the browser's toolbar takes (`--bg` in
 * tokens.css and in styles/camelot.css). Pure data: the server writes it into the page, and the
 * page itself reads it when the look or the scheme changes.
 */
export const PAGE_COLORS = {
	modern: { light: "#f5f6f8", dark: "#0f1115" },
	camelot: { light: "#f4ead5", dark: "#0f1726" },
} as const;

export type PageLookName = keyof typeof PAGE_COLORS;
