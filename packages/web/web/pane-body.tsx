import type { ReactNode } from "react";
import type { ConfigView, GateStepView } from "../src/api-types.ts";
import type { NavItem } from "./app-chrome.tsx";
import {
	AgentPage,
	ArrangePage,
	ChatsHome,
	ConnectorsPage,
	ConversationsPage,
	GatePage,
	HostRoomPage,
	NotesPage,
	OverviewPage,
	PromptsPage,
	SchedulesPage,
	SettingsPage,
	SkillsPage,
	TablePage,
	TranscriptPage,
	WorkspacePage,
} from "./app-pages.ts";
import { Failure } from "./components/states.tsx";
import { translate as t } from "./lib/messages.ts";
import { PAGE_ROUTES } from "./lib/page-routes.ts";
import { MorePage } from "./pages/more.tsx";
import { RoomPage } from "./pages/room.tsx";
import { RoomsPage } from "./pages/rooms.tsx";

/** What the open pane shows in the column: the page the route names, the closed notice for an account that is no owner, or the step the gate owes. */
export function PaneBody(props: {
	config: ConfigView;
	pane: string;
	routeKey: string | undefined;
	forbidden: boolean;
	gateShown: boolean;
	owed: readonly GateStepView[];
	wide: boolean;
	moreItems: NavItem[];
	openPalette: () => void;
}): ReactNode {
	const {
		config,
		pane,
		forbidden,
		gateShown,
		owed,
		wide,
		moreItems,
		openPalette,
	} = props;
	const route = { key: props.routeKey };
	const app = config.app;
	if (forbidden)
		return (
			<div className="page">
				<Failure
					message={t(
						"This account is not an owner of this host, so the app stays closed. Reload the page to try again.",
					)}
				/>
			</div>
		);
	if (gateShown) return <GatePage steps={owed} />;
	const chats = app?.home === "chats";
	/** The home: the chat list, or the arranged room list. */
	const home = (active?: string) =>
		chats ? (
			<ChatsHome onSearch={openPalette} active={active} column={wide} />
		) : (
			<RoomsPage onSearch={openPalette} active={active} />
		);
	switch (pane) {
		case "rooms":
			// Wide enough, the column stands beside a place for the room that is not open yet.
			return chats && wide ? (
				<div className="split" data-chats="">
					<div className="split-list">{home()}</div>
					<div className="split-detail">
						<p className="split-empty">{t("Choose a chat from the list.")}</p>
					</div>
				</div>
			) : (
				home()
			);
		case "arrange":
			return <ArrangePage onSearch={openPalette} />;
		case "room": {
			if (!route.key) return home();
			const detail = (config.kinds ?? []).some((kind) =>
				route.key?.startsWith(`${app?.surface}:${kind.kind}.`),
			) ? (
				<HostRoomPage key={route.key} roomKey={route.key} />
			) : (
				<RoomPage key={route.key} roomKey={route.key} />
			);
			return wide ? (
				<div className="split" {...(chats ? { "data-chats": "" } : {})}>
					<div className="split-list">{home(route.key)}</div>
					<div className="split-detail">{detail}</div>
				</div>
			) : (
				detail
			);
		}
		case "agent":
			return route.key ? <AgentPage key={route.key} name={route.key} /> : null;
		case "schedules":
			return <SchedulesPage />;
		case "table":
			return <TablePage focus={route.key} />;
		case "workspace":
			return <WorkspacePage />;
		case "settings":
			return <SettingsPage />;
		case "prompts":
			return <PromptsPage />;
		case "more":
			return <MorePage items={moreItems} />;
		case "overview":
			return (
				<Legacy>
					<OverviewPage />
				</Legacy>
			);
		case "conversations":
			return (
				<Legacy>
					{route.key ? (
						<TranscriptPage key={route.key} conversationKey={route.key} />
					) : (
						<ConversationsPage />
					)}
				</Legacy>
			);
		case "notes":
			return (
				<Legacy>
					<NotesPage />
				</Legacy>
			);
		case "skills":
			return (
				<Legacy>
					<SkillsPage />
				</Legacy>
			);
		case "connectors":
			return (
				<Legacy>
					<ConnectorsPage />
				</Legacy>
			);
		default: {
			const Extra = PAGE_ROUTES[pane];
			return Extra ? <Extra pane={pane} routeKey={route.key} /> : null;
		}
	}
}

function Legacy({ children }: { children: ReactNode }) {
	return <div className="page">{children}</div>;
}
