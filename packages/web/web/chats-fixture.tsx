import { spyOn } from "bun:test";
import type { ArchivedEntry, ConfigView, RoomView } from "../src/api-types.ts";
import { ActionMenuHost } from "./components/action-menu.tsx";
import { RoomConfirmHost } from "./components/room-confirms.tsx";
import { Toaster } from "./components/toaster.tsx";
import { BUILD, HOME, SCOUT, TEAM, view } from "./folders-fixture.tsx";
import { store } from "./lib/app-store.ts";
import { ConfigContext } from "./lib/config.ts";
import { setHomeMode } from "./lib/home-mode.ts";
import { seedUnread } from "./lib/host-state.ts";
import { teamApi } from "./lib/team-api.ts";
import ChatsHome from "./pages/chats-home.tsx";

export const GUIDE = HOME;
export const NEWS = "app:agent.news";
export const LOGS = "app:agent.logs";
export const QUIET = "app:agent.quiet";
export const T1 = "app:thread.00000000-0000-4000-8000-000000000001";
export const T2 = "app:thread.00000000-0000-4000-8000-000000000002";
export const F1 = "folder.00000000-0000-4000-8000-000000000001";
export const F2 = "folder.00000000-0000-4000-8000-000000000002";

/** The config of a host that opens the app on the chat list, with the panes the grid builds from. */
export const chatsConfig: ConfigView = {
	title: "Console",
	panes: [
		"rooms",
		"schedules",
		"workspace",
		"table",
		"notes",
		"skills",
		"profile",
	],
	timeZone: "UTC",
	look: "modern",
	app: { surface: "app", protocol: "roundtable.app.v1", home: "chats" },
};

export const archived = (count: number): ArchivedEntry[] =>
	Array.from({ length: count }, (_, i) => ({
		kind: "agent" as const,
		name: `old${i}`,
		displayName: `Old ${i}`,
	}));

/** The chat home with the hosts the page draws menus in. */
export const Home = (props: {
	active?: string;
	column?: boolean;
	config?: ConfigView;
}) => (
	<ConfigContext.Provider value={props.config ?? chatsConfig}>
		<ChatsHome
			onSearch={() => undefined}
			active={props.active}
			column={props.column ?? false}
		/>
		<ActionMenuHost />
		<RoomConfirmHost />
		<Toaster />
	</ConfigContext.Provider>
);

export const rooms = (extra: RoomView[] = []): RoomView[] => [
	view(GUIDE, { home: true }),
	view(SCOUT),
	view(BUILD),
	view(NEWS),
	view(TEAM, { members: ["scout"] }),
	...extra,
];

export function loadChats(
	layout: {
		pins?: string[];
		hidden?: string[];
		folders?: { id: string; name: string; rooms: string[] }[];
	} = {},
	list: RoomView[] = rooms(),
): void {
	setHomeMode("chats");
	store.dispatch({
		type: "rooms_loaded",
		rooms: list,
		pins: layout.pins ?? [],
		hidden: layout.hidden ?? [],
		folders: layout.folders ?? [],
	});
}

/** Answers the archive's count, and the unread counts the page reads. */
export function seed(archive = 0, unread: Record<string, number> = {}) {
	seedUnread(
		Object.fromEntries(
			[GUIDE, SCOUT, BUILD, NEWS, TEAM, QUIET].map((key) => [
				key,
				unread[key] ?? 0,
			]),
		),
	);
	return spyOn(teamApi, "archive").mockResolvedValue({
		entries: archived(archive),
	});
}
