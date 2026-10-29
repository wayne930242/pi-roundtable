import {
	lazy,
	type ReactNode,
	Suspense,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import type { ConfigView, PaneName } from "../src/api-types.ts";
import { ActionMenuHost } from "./components/action-menu.tsx";
import { ErrorBoundary } from "./components/boundary.tsx";
import { BrandMark } from "./components/brand-mark.tsx";
import { ConnectionGate } from "./components/connection-gate.tsx";
import { Icon, type IconName } from "./components/icons.tsx";
import { Palette } from "./components/palette.tsx";
import { RoomConfirmHost } from "./components/room-confirms.tsx";
import { Failure, Loading } from "./components/states.tsx";
import { Toaster } from "./components/toaster.tsx";
import { api, messageOf } from "./lib/api.ts";
import { store, useSelector } from "./lib/app-store.ts";
import { ConfigContext } from "./lib/config.ts";
import { LiveContext, useLiveSource } from "./lib/live.ts";
import { initLook } from "./lib/look.ts";
import { useMedia } from "./lib/media.ts";
import {
	loadBuiltInMessages,
	setPresentation,
	translate as t,
	wording,
} from "./lib/messages.ts";
import { hrefFor, setRouting, useRoute } from "./lib/router.ts";
import { setTheme, useTheme } from "./lib/theme.ts";
import { AgentPage } from "./pages/agent.tsx";
import { MorePage, PANE_ICONS } from "./pages/more.tsx";
import { RoomPage } from "./pages/room.tsx";
import { RoomsPage } from "./pages/rooms.tsx";
import { SchedulesPage } from "./pages/schedules.tsx";
import { SettingsPage } from "./pages/settings.tsx";

// The older panes are read less often than the rooms, so they load when first opened.
const OverviewPage = lazy(() =>
	import("./pages/overview.tsx").then((m) => ({ default: m.OverviewPage })),
);
const ConversationsPage = lazy(() =>
	import("./pages/conversations.tsx").then((m) => ({
		default: m.ConversationsPage,
	})),
);
const TranscriptPage = lazy(() =>
	import("./pages/transcript.tsx").then((m) => ({ default: m.TranscriptPage })),
);
const NotesPage = lazy(() =>
	import("./pages/notes.tsx").then((m) => ({ default: m.NotesPage })),
);
const SkillsPage = lazy(() =>
	import("./pages/skills.tsx").then((m) => ({ default: m.SkillsPage })),
);
const ConnectorsPage = lazy(() =>
	import("./pages/connectors.tsx").then((m) => ({ default: m.ConnectorsPage })),
);
// The table's page is light, and the scene it mounts is a chunk of its own that waits for the view to open.
const TablePage = lazy(() =>
	import("./pages/table.tsx").then((m) => ({ default: m.TablePage })),
);

const LABELS: Record<PaneName | "settings" | "more", string> = {
	overview: wording("Overview"),
	conversations: wording("Conversations"),
	notes: wording("Notes"),
	skills: wording("Skills"),
	connectors: wording("Connectors"),
	rooms: wording("Rooms"),
	schedules: wording("Schedules"),
	table: wording("Round table"),
	settings: wording("Settings"),
	more: wording("More"),
};

export function App() {
	const [config, setConfig] = useState<ConfigView>();
	const [error, setError] = useState<string>();
	useEffect(() => {
		api
			.config()
			.then(async (loaded) => {
				// The locale the bootstrap named is usually the same; a host with none in the page names it here.
				// Wording that fails to load leaves the page in English rather than unusable.
				await loadBuiltInMessages(loaded.locale).catch((failure) =>
					console.warn("the built-in wording failed to load", failure),
				);
				setPresentation(loaded);
				initLook(loaded.look);
				setRouting(loaded.mountPath, loaded.panes[0]);
				document.documentElement.lang = loaded.locale ?? "en";
				setConfig(loaded);
				document.title = loaded.title;
			})
			.catch((failure) => setError(messageOf(failure)));
	}, []);
	if (!config)
		return (
			<div className="page">
				{error ? <Failure message={error} /> : <Loading />}
			</div>
		);
	const shell = <Console config={config} />;
	return (
		<ConfigContext.Provider value={config}>
			{/* The connection opens before the first render under it, which a room reloaded in place asks for. */}
			{config.app && config.panes.includes("rooms") ? (
				<ConnectionGate protocol={config.app.protocol}>{shell}</ConnectionGate>
			) : (
				shell
			)}
		</ConfigContext.Provider>
	);
}

interface NavItem {
	pane: string;
	label: string;
	icon: IconName;
}

/** Keeps the layout the size of what the person can see: the visible area shrinks when the on-screen keyboard rises. */
function useViewportSize(): void {
	useEffect(() => {
		const viewport = window.visualViewport;
		const root = document.documentElement;
		const apply = () => {
			root.style.setProperty(
				"--app-height",
				`${viewport?.height ?? window.innerHeight}px`,
			);
			root.style.setProperty("--app-top", `${viewport?.offsetTop ?? 0}px`);
		};
		apply();
		viewport?.addEventListener("resize", apply);
		viewport?.addEventListener("scroll", apply);
		window.addEventListener("resize", apply);
		return () => {
			viewport?.removeEventListener("resize", apply);
			viewport?.removeEventListener("scroll", apply);
			window.removeEventListener("resize", apply);
		};
	}, []);
}

/** Fetches the room list at the start, after every `changed` and after every reconnect. */
function useRoomsSync(enabled: boolean, version: number): void {
	const revision = useSelector((state) => state.revision);
	const connects = useSelector((state) => state.connects);
	// biome-ignore lint/correctness/useExhaustiveDependencies: the counters say when to fetch
	useEffect(() => {
		if (!enabled) return;
		let current = true;
		api.rooms().then(
			(view) => {
				if (current)
					store.dispatch({ type: "rooms_loaded", rooms: view.rooms });
			},
			() => undefined,
		);
		return () => {
			current = false;
		};
	}, [enabled, revision, connects, version]);
}

function ThemeButton() {
	const { resolved } = useTheme();
	return (
		<button
			type="button"
			className="icon-button"
			aria-label={
				resolved === "dark" ? t("Switch to light") : t("Switch to dark")
			}
			onClick={(event) => {
				const box = event.currentTarget.getBoundingClientRect();
				setTheme(resolved === "dark" ? "light" : "dark", {
					x: box.left + box.width / 2,
					y: box.top + box.height / 2,
				});
			}}
		>
			<Icon name={resolved === "dark" ? "sun" : "moon"} />
		</button>
	);
}

function Console({ config }: { config: ConfigView }) {
	const live = useLiveSource();
	const route = useRoute();
	const app = config.app;
	const hasApp = app !== undefined && config.panes.includes("rooms");
	const [palette, setPalette] = useState(false);
	// Wide enough, the room list stands beside the open room.
	const wide = useMedia("(min-width: 1024px)");
	const stage = useRef<HTMLDivElement>(null);
	useViewportSize();
	useRoomsSync(hasApp, live.version);

	const connection = useSelector((state) => state.connection);
	const forbidden = useSelector((state) => state.forbidden);
	const waiting = useSelector(
		(state) => state.cardOrder.filter((id) => !state.cards[id]?.outcome).length,
	);

	useEffect(() => {
		document.title = waiting ? `(${waiting}) ${config.title}` : config.title;
	}, [waiting, config.title]);

	// Ctrl+K or ⌘K opens the room switcher from anywhere.
	useEffect(() => {
		if (!hasApp) return;
		const onKey = (event: KeyboardEvent) => {
			if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
				event.preventDefault();
				setPalette((open) => !open);
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [hasApp]);

	const items: NavItem[] = useMemo(
		() => [
			...config.panes.map((pane) => ({
				pane,
				label: t(LABELS[pane]),
				icon: PANE_ICONS[pane],
			})),
			...(hasApp
				? [
						{
							pane: "settings",
							label: t("Settings"),
							icon: PANE_ICONS.settings,
						},
					]
				: []),
		],
		[config.panes, hasApp],
	);

	const first = config.panes[0] ?? "conversations";
	const known = (name: string) =>
		config.panes.includes(name as PaneName) ||
		(hasApp && ["room", "agent", "settings", "more"].includes(name)) ||
		name === "more";
	const pane = known(route.pane) ? route.pane : first;
	// The room and the profile fill the screen; everything else is a page in a column.
	const fill =
		hasApp && (pane === "room" || pane === "agent") && Boolean(route.key);
	const current = pane === "room" || pane === "agent" ? "rooms" : pane;

	// A page opens at its top.
	// biome-ignore lint/correctness/useExhaustiveDependencies: the route changing is the trigger
	useEffect(() => {
		stage.current?.scrollTo(0, 0);
	}, [pane, route.key]);

	const tabs: NavItem[] = (() => {
		const lead = items.slice(0, 3);
		return items.length > 4
			? [...lead, { pane: "more", label: t("More"), icon: PANE_ICONS.more }]
			: items;
	})();
	const moreItems = items.filter(
		(item) => !tabs.some((tab) => tab.pane === item.pane),
	);

	const body: ReactNode = (() => {
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
		switch (pane) {
			case "rooms":
				return <RoomsPage onSearch={() => setPalette(true)} />;
			case "room":
				if (!route.key) return <RoomsPage onSearch={() => setPalette(true)} />;
				return wide ? (
					<div className="split">
						<div className="split-list">
							<RoomsPage onSearch={() => setPalette(true)} active={route.key} />
						</div>
						<div className="split-detail">
							<RoomPage key={route.key} roomKey={route.key} />
						</div>
					</div>
				) : (
					<RoomPage key={route.key} roomKey={route.key} />
				);
			case "agent":
				return route.key ? (
					<AgentPage key={route.key} name={route.key} />
				) : null;
			case "schedules":
				return <SchedulesPage />;
			case "table":
				return <TablePage />;
			case "settings":
				return <SettingsPage />;
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
			default:
				return null;
		}
	})();

	const online = hasApp ? connection === "open" : live.connected;
	const chip = (
		<span
			className="live-chip"
			data-on={online || undefined}
			title={online ? t("Receiving live updates") : t("Reconnecting")}
		>
			{online ? t("Live") : t("Reconnecting…")}
		</span>
	);

	return (
		<LiveContext.Provider value={live}>
			<div className="app" data-fill={fill || undefined}>
				<aside className="rail">
					<div className="brand">
						<BrandMark />
						<h1>{config.title}</h1>
					</div>
					<nav className="rail-nav" aria-label={t("Panes")}>
						{items.map((item) => (
							<a
								key={item.pane}
								className="rail-link"
								href={hrefFor(item.pane)}
								aria-current={item.pane === current ? "page" : undefined}
							>
								<Icon name={item.icon} />
								{item.label}
								{item.pane === "rooms" && waiting ? (
									<span className="tab-badge">{waiting}</span>
								) : null}
							</a>
						))}
					</nav>
					<div className="rail-foot">
						{chip}
						{hasApp ? (
							<button
								type="button"
								className="icon-button"
								aria-label={t("Find a room")}
								onClick={() => setPalette(true)}
							>
								<Icon name="search" />
							</button>
						) : null}
						<ThemeButton />
					</div>
				</aside>
				<div className="stage" ref={stage} data-fill={fill || undefined}>
					<header className="topbar">
						<div className="brand">
							<BrandMark />
							<h1>{config.title}</h1>
						</div>
						<div className="topbar-end">
							{chip}
							<ThemeButton />
						</div>
					</header>
					<main
						className="route"
						// Beside the list the room changes under it; the list stays where it is.
						key={
							wide && pane === "room" ? "room" : `${pane}/${route.key ?? ""}`
						}
					>
						<ErrorBoundary resetKey={`${pane}/${route.key ?? ""}`}>
							<Suspense
								fallback={
									<div className="page">
										<Loading />
									</div>
								}
							>
								{body}
							</Suspense>
						</ErrorBoundary>
					</main>
				</div>
				<nav className="tabbar" aria-label={t("Panes")}>
					{tabs.map((item) => (
						<a
							key={item.pane}
							className="tab"
							href={hrefFor(item.pane)}
							aria-current={
								item.pane === current ||
								(item.pane === "more" &&
									moreItems.some((m) => m.pane === current))
									? "page"
									: undefined
							}
						>
							<Icon name={item.icon} size={22} />
							<span>{item.label}</span>
							{item.pane === "rooms" && waiting ? (
								<span className="tab-badge">{waiting}</span>
							) : null}
						</a>
					))}
				</nav>
			</div>
			<Toaster />
			{hasApp ? (
				<>
					<ActionMenuHost />
					<RoomConfirmHost />
				</>
			) : null}
			{hasApp ? (
				<Palette
					open={palette}
					onClose={() => setPalette(false)}
					pages={items}
				/>
			) : null}
		</LiveContext.Provider>
	);
}

function Legacy({ children }: { children: ReactNode }) {
	return <div className="page">{children}</div>;
}
