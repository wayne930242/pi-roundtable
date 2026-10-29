import { addIcons } from "../components/icons.tsx";

// The icons the pin, folder and move menus draw. They load with those menus, not with the first page.
const PATHS = {
	pin: "M9 4h6l-1 6 3 3H7l3-3-1-6ZM12 13v7",
	folder:
		"M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z",
	up: "M6 15l6-6 6 6",
	down: "M6 9l6 6 6-6",
	edit: "M4 20h4L19 9l-4-4L4 16v4ZM13.5 6.5l4 4",
} as const;

export type LayoutIconName = keyof typeof PATHS;

addIcons(PATHS);
