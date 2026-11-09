import { addIcons } from "../components/icons.tsx";

// The icons the chat home draws. They load with the home, not with the first page.
const PATHS = {
	grid: "M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM17 14v6M14 17h6",
	star: "M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1.1 5.9L12 16.9l-5.3 2.8 1.1-5.9L3.5 9.7l5.9-.8L12 3.5Z",
	hourglass: "M7 3h10M7 21h10M8 3v4l4 5-4 5v4M16 3v4l-4 5 4 5v4",
} as const;

export type HomeIconName = keyof typeof PATHS;

addIcons(PATHS);
