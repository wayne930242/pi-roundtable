import { lazy } from "react";
import { hostUi } from "./lib/frame-taps.ts";

// The older panes are read less often than the rooms, so they load when first opened.
// The menus' drawing loads once the page has: a long press is never the first thing a person does.
export const ActionMenuHost = lazy(() =>
	import("./components/action-menu.tsx").then((m) => ({
		default: m.ActionMenuHost,
	})),
);
export const Palette = lazy(() =>
	import("./components/palette.tsx").then((m) => ({ default: m.Palette })),
);
export const SheetHosts = lazy(() =>
	import("./components/sheet-hosts.tsx").then((m) => ({
		default: m.SheetHosts,
	})),
);
export const RoomConfirmHost = lazy(() =>
	import("./components/room-confirms.tsx").then((m) => ({
		default: m.RoomConfirmHost,
	})),
);
// The bell and the gate's page load with the first notice or the first gated visit, not with the page.
export const NoticeBell = lazy(() => import("./components/notice-bell.tsx"));
export const GatePage = lazy(() =>
	import("./pages/gate.tsx").then((m) => ({ default: m.GatePage })),
);
export const AgentPage = lazy(() =>
	import("./pages/agent.tsx").then((m) => ({ default: m.AgentPage })),
);
// A host's rooms load when the first one opens.
export const HostRoomPage = lazy(() =>
	hostUi().then((ui) => ({ default: ui.HostRoomPage })),
);
// The chat home, and the room list that stays as its management view, load when first opened.
export const ChatsHome = lazy(() => import("./pages/chats-home.tsx"));
export const ArrangePage = lazy(() =>
	import("./pages/arranged-rooms.tsx").then((m) => ({
		default: m.ArrangedRoomsPage,
	})),
);
export const SchedulesPage = lazy(() =>
	import("./pages/schedules.tsx").then((m) => ({ default: m.SchedulesPage })),
);
export const PromptsPage = lazy(() =>
	import("./pages/prompts.tsx").then((m) => ({ default: m.PromptsPage })),
);
export const OverviewPage = lazy(() =>
	import("./pages/overview.tsx").then((m) => ({ default: m.OverviewPage })),
);
export const ConversationsPage = lazy(() =>
	import("./pages/conversations.tsx").then((m) => ({
		default: m.ConversationsPage,
	})),
);
export const TranscriptPage = lazy(() =>
	import("./pages/transcript.tsx").then((m) => ({ default: m.TranscriptPage })),
);
export const NotesPage = lazy(() =>
	import("./pages/notes.tsx").then((m) => ({ default: m.NotesPage })),
);
export const SkillsPage = lazy(() =>
	import("./pages/skills.tsx").then((m) => ({ default: m.SkillsPage })),
);
export const ConnectorsPage = lazy(() =>
	import("./pages/connectors.tsx").then((m) => ({ default: m.ConnectorsPage })),
);
// The files pane is light too; its editor is a chunk of its own that waits for the first file to open.
export const WorkspacePage = lazy(() =>
	import("./pages/workspace.tsx").then((m) => ({ default: m.WorkspacePage })),
);
// Settings is not where a visit starts, so its page loads when it first opens.
export const SettingsPage = lazy(() =>
	import("./pages/settings.tsx").then((m) => ({ default: m.SettingsPage })),
);
// The table's page is light, and the scene it mounts is a chunk of its own that waits for the view to open.
export const TablePage = lazy(() =>
	import("./pages/table.tsx").then((m) => ({ default: m.TablePage })),
);
