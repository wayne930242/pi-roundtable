import type { SVGProps } from "react";

// A small set of line icons on a 24px grid, drawn here so the page loads nothing else.
const PATHS = {
	rooms: "M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-4.7A8 8 0 1 1 21 12Z",
	schedules: "M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z",
	settings: "M4 7h9M17 7h3M4 17h3M11 17h9M15 4v6M9 14v6",
	more: "M5 12h.01M12 12h.01M19 12h.01",
	back: "M15 5l-7 7 7 7",
	send: "M12 19V5M5 12l7-7 7 7",
	stop: "M7 7h10v10H7z",
	attach:
		"M20 11.5l-8.2 8.2a5 5 0 0 1-7-7l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.6 8.6a1.7 1.7 0 0 1-2.4-2.4l7.9-7.9",
	menu: "M12 5h.01M12 12h.01M12 19h.01",
	sun: "M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z",
	moon: "M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z",
	system: "M4 5h16v11H4zM9 20h6M12 16v4",
	bolt: "M13 3L5 13.5h6L10 21l8-10.5h-6L13 3Z",
	timer: "M10 2h4M12 8v5l3 2M20 13a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z",
	check: "M5 12.5l4.5 4.5L19 7.5",
	close: "M6 6l12 12M18 6L6 18",
	copy: "M9 9h10v11H9zM5 15V4h10",
	search: "M11 18a7 7 0 1 1 0-14 7 7 0 0 1 0 14Zm5-2l5 5",
	overview: "M4 4h7v7H4zM13 4h7v4h-7zM13 11h7v9h-7zM4 14h7v6H4z",
	conversations: "M4 5h16v11H9l-5 4V5Z",
	notes: "M6 3h9l4 4v14H6zM14 3v5h5M9 13h7M9 17h5",
	skills:
		"M10 4a2 2 0 1 1 4 0v2h4v4h-2a2 2 0 1 0 0 4h2v4h-4v-2a2 2 0 1 0-4 0v2H6v-4h2a2 2 0 1 0 0-4H6V6h4V4Z",
	connectors: "M9 3v5M15 3v5M6 8h12v4a6 6 0 0 1-12 0V8ZM12 18v3",
	trash: "M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13",
	refresh:
		"M20 11a8 8 0 0 0-14.5-3.5L4 9M4 4v5h5M4 13a8 8 0 0 0 14.5 3.5L20 15M20 20v-5h-5",
	download: "M12 4v11M7 11l5 5 5-5M5 20h14",
	file: "M6 3h9l4 4v14H6zM14 3v5h5",
	logout: "M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10",
	profile: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM4 21a8 8 0 0 1 16 0",
	reset: "M4 4v6h6M4.5 10A8 8 0 1 1 6 16",
	chevron: "M9 6l6 6-6 6",
	sparkle: "M12 3l2 5.5L19.5 10 14 12l-2 5.5L10 12l-5.5-2L10 8.5 12 3Z",
	shield: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3Z",
	table:
		"M3 12a9 4.5 0 1 0 18 0 9 4.5 0 1 0-18 0ZM6.5 14.5L5 19M17.5 14.5L19 19M12 16.5V20",
	list: "M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01",
	bell: "M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15L6 16ZM10 21h4",
	"bell-off":
		"M6 16V11a6 6 0 0 1 .8-3M9.5 5.2A6 6 0 0 1 18 11v5l1.5 2H8M10 21h4M4 4l16 16",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({
	name,
	size = 20,
	...rest
}: { name: IconName; size?: number } & Omit<SVGProps<SVGSVGElement>, "name">) {
	return (
		<svg
			viewBox="0 0 24 24"
			width={size}
			height={size}
			fill="none"
			stroke="currentColor"
			strokeWidth={1.8}
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
			focusable="false"
			{...rest}
		>
			<path d={PATHS[name]} />
		</svg>
	);
}
