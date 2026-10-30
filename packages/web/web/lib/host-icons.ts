import { addIcons } from "../components/icons.tsx";

// The icons a host may name for its pages and kinds of room that the first page does not draw
// itself. They load once the console's config names one, not with the first page.
const PATHS = {
	chat: "M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-4.7A8 8 0 1 1 21 12Z",
	link: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3A4 4 0 0 0 11 18.7l1-1",
	activity: "M3 12h4l3-8 4 16 3-8h4",
	users:
		"M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 6.5M18 14a6.5 6.5 0 0 1 3.5 6",
	megaphone: "M4 10v4h3l8 4V6L7 10H4ZM18 9a4 4 0 0 1 0 6M7 14l1 6h3l-1-5",
	qr: "M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 14h2v2M14 18h2M18 18h2v2h-2z",
} as const;

export type HostGlyphName = keyof typeof PATHS;

addIcons(PATHS);
