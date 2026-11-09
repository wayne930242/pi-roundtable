import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import type { ConfigView, PaneName } from "../src/api-types.ts";
import { type NavItem, ThemeButton, useViewportSize } from "./app-chrome.tsx";
import {
	ActionMenuHost,
	NoticeBell,
	Palette,
	RoomConfirmHost,
	SheetHosts,
} from "./app-pages.ts";
import { ErrorBoundary } from "./components/boundary.tsx";
import { BrandMark } from "./components/brand-mark.tsx";
import { ConnectionGate } from "./components/connection-gate.tsx";
import { Icon, type IconName } from "./components/icons.tsx";
import { Failure, Loading } from "./components/states.tsx";
import { Toaster } from "./components/toaster.tsx";
import { WaitingButton } from "./components/waiting-button.tsx";
import { api, messageOf, setPushSubscribe } from "./lib/api.ts";
import { useSelector } from "./lib/app-store.ts";
import { ConfigContext } from "./lib/config.ts";
import { setHomeMode } from "./lib/home-mode.ts";
import { LiveContext, useLiveSource } from "./lib/live.ts";
import { initLook } from "./lib/look.ts";
import { useMedia } from "./lib/media.ts";
import {
	loadBuiltInMessages,
	setPresentation,
	translate as t,
} from "./lib/messages.ts";
import { GATE_ROUTES, knownPane, PAGE_ROUTES } from "./lib/page-routes.ts";
import { useRoomsSync } from "./lib/rooms-sync.ts";
import { hrefFor, pageKey, setRouting, useRoute } from "./lib/router.ts";
import { isSearchKey } from "./lib/search-key.ts";
import { initSkins } from "./lib/skins.ts";
import { openCards, tabTitle, useTabUnread } from "./lib/tab-count.ts";
import { PANE_ICONS, PANE_LABELS } from "./pages/more.tsx";
import { PaneBody } from "./pane-body.tsx";

export function App() {
	const [config, setConfig] = useState<ConfigView>();
	const [error, setError] = useState<string>();
	useEffect(() => {
		api
			.config()
			.then(async (loaded) => {
				// The locale the bootstrap named is usually the same; a host with none in the page names it here, and wording that fails to load leaves the page in English rather than unusable.
				await loadBuiltInMessages(loaded.locale).catch((failure) =>
					console.warn("the built-in wording failed to load", failure),
				);
				setPresentation(loaded);
				initLook(loaded.look);
				initSkins(loaded.characterSkins);
				setRouting(loaded.mountPath, loaded.panes[0]);
				setHomeMode(loaded.app?.home === "chats" ? "chats" : "rooms");
				setPushSubscribe(loaded.push?.subscribe);
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
			{/* The connection opens before the first render under it, which a room reloaded in place asks for. A person with no rooms still has it: their notices and the gate arrive on it. */}
			{config.app ? (
				<ConnectionGate protocol={config.app.protocol}>{shell}</ConnectionGate>
			) : (
				shell
			)}
		</ConfigContext.Provider>
	);
}

/** What the back bar of a page other than the home calls it. */
function barTitle(
	pane: string,
	items: readonly NavItem[],
	current: string,
	fallback: string,
): string {
	if (pane === "hidden") return t("Hidden and archived");
	if (pane === "arrange") return t("Folders and order");
	return items.find((item) => item.pane === current)?.label ?? fallback;
}

function Console({ config }: { config: ConfigView }) {
	const live = useLiveSource();
	const route = useRoute();
	const app = config.app;
	const hasApp = app !== undefined && config.panes.includes("rooms");
	// The host opens the app on the chat list: no rail and no tab bar, and a back control on the other pages.
	const chats = hasApp && app?.home === "chats";
	// The rest of the home's styles load beside it; the shell's are in the page's stylesheet.
	useEffect(() => {
		if (chats)
			import("./lib/chats-home-style.ts").then((m) =>
				m.installChatsHomeStyle(),
			);
	}, [chats]);
	const [palette, setPalette] = useState(false);
	// Wide enough, the room list stands beside the open room.
	const wide = useMedia("(min-width: 1024px)");
	// From here the rail stands beside the page and the top and tab bars are gone.
	const sideRail = useMedia("(min-width: 720px)");
	const stage = useRef<HTMLDivElement>(null);
	useViewportSize();
	useRoomsSync(hasApp, live.version);
	// The icons a host names for its pages load once one does, and the navigation draws again with them.
	const [, setHostIcons] = useState(false);
	const namesIcon = (config.pages ?? []).some((page) => page.icon);
	useEffect(() => {
		if (namesIcon) import("./lib/host-icons.ts").then(() => setHostIcons(true));
	}, [namesIcon]);

	const connection = useSelector((state) => state.connection);
	const forbidden = useSelector((state) => state.forbidden);
	// The steps the person owes: what the socket last said, else what the config said.
	const liveGate = useSelector((state) => state.gate);
	const owed = liveGate ?? config.gate ?? [];
	const gated = owed.length > 0;
	const wasGated = useRef(gated);
	useEffect(() => {
		// The last step was finished: load the page again, so it comes up with everything the person may now see.
		if (wasGated.current && !gated) window.location.reload();
		wasGated.current = gated;
	}, [gated]);
	const waiting = useSelector(openCards);
	// The notices and unread messages, counted by the tab dot's module (a chunk that loads after the first paint).
	const unread = useTabUnread();
	useEffect(() => {
		import("./lib/tab-dot.ts")
			.then((tab) => tab.startPageTabDot())
			.catch((failure: unknown) =>
				console.warn("the tab icon's dot failed to load", failure),
			);
	}, []);

	useEffect(() => {
		document.title = tabTitle(config.title, waiting + unread);
	}, [waiting, unread, config.title]);

	// Ctrl+K or ⌘K opens the room switcher from anywhere.
	useEffect(() => {
		if (!hasApp) return;
		const onKey = (event: KeyboardEvent) => {
			if (isSearchKey(event)) {
				event.preventDefault();
				setPalette((open) => !open);
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [hasApp]);

	// The other shortcuts (room switching, the help sheet, Esc) are a part of their own that loads after the first paint.
	const shortcuts = hasApp && !gated;
	useEffect(() => {
		if (!shortcuts) return;
		let stop: (() => void) | undefined;
		let gone = false;
		import("./lib/shortcuts.ts")
			.then((module) => {
				if (!gone) stop = module.startShortcuts();
			})
			.catch((failure: unknown) =>
				console.warn("the keyboard shortcuts failed to load", failure),
			);
		return () => {
			gone = true;
			stop?.();
		};
	}, [shortcuts]);

	const items: NavItem[] = useMemo(() => {
		const all: NavItem[] = [
			...config.panes.map((pane) => ({
				pane,
				label: t(PANE_LABELS[pane]),
				icon: PANE_ICONS[pane],
			})),
			// The host's own pages stand beside the panes, under `p/<id>`.
			...(config.pages ?? [])
				.filter((page) => page.place === "main")
				.map((page) => ({
					pane: `p/${page.id}`,
					label: page.label,
					icon: (page.icon ?? "list") as IconName,
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
		];
		// While a step is owed only the person's own pages are offered.
		return gated ? all.filter((item) => GATE_ROUTES.has(item.pane)) : all;
	}, [config.panes, config.pages, hasApp, gated]);

	const first = config.panes[0] ?? "conversations";
	const known = (name: string) => knownPane(name, config.panes, hasApp, chats);
	const pane = known(route.pane) ? route.pane : first;
	// The pages that finish an owed step, besides the person's own.
	const opensOwed = owed.some(
		(step) => step.open.page === (pane === "p" ? route.key : pane),
	);
	const gateShown = gated && !GATE_ROUTES.has(pane) && !opensOwed;
	// The room and the profile fill the screen; everything else is a page in a column.
	const fill =
		(hasApp && (pane === "room" || pane === "agent") && Boolean(route.key)) ||
		// The files fill the screen beside the rail, and a phone's file leaves the keyboard its room.
		(pane === "workspace" &&
			((!chats && sideRail) || /[^:/]$/.test(route.key ?? ""))) ||
		// Wide enough, the chat list is a column beside the room and fills the screen with it.
		(chats && wide && (pane === "rooms" || pane === "room"));
	const atHome = pane === "rooms" || (pane === "room" && !route.key);
	// The page's own bar, with the way back to the chat home.
	const bar = chats && !fill && !atHome;
	const current =
		pane === "room" || pane === "agent"
			? "rooms"
			: pane === "prompts"
				? "settings"
				: pane === "p"
					? `p/${route.key}`
					: pane;

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

	const body = (
		<PaneBody
			config={config}
			pane={pane}
			routeKey={route.key}
			forbidden={forbidden}
			gateShown={gateShown}
			owed={owed}
			wide={wide}
			moreItems={moreItems}
			openPalette={() => setPalette(true)}
		/>
	);

	const online = app ? connection === "open" : live.connected;
	// Where the app admits more than its owners, the bell shows what waits on the person.
	const bell =
		config.tier !== undefined ? (
			<Suspense fallback={null}>
				<NoticeBell />
			</Suspense>
		) : null;
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
			<div
				className="app"
				data-fill={fill || undefined}
				data-home={chats ? "chats" : undefined}
				data-bar={bar || undefined}
			>
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
						<WaitingButton />
						{bell}
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
						{chats ? (
							<>
								<a
									className="icon-button back-link"
									href={hrefFor("rooms")}
									aria-label={t("Back to rooms")}
								>
									<Icon name="back" />
								</a>
								<h1>{barTitle(pane, items, current, config.title)}</h1>
							</>
						) : (
							<>
								<div className="brand">
									<BrandMark />
									<h1>{config.title}</h1>
								</div>
								<div className="topbar-end">
									{chip}
									<WaitingButton />
									{bell}
									<ThemeButton />
								</div>
							</>
						)}
					</header>
					<main className="route" key={pageKey(pane, route.key, wide)}>
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
				<Suspense fallback={null}>
					<ActionMenuHost />
					<SheetHosts />
					<RoomConfirmHost />
					<Palette
						open={palette}
						onClose={() => setPalette(false)}
						pages={items}
					/>
				</Suspense>
			) : null}
		</LiveContext.Provider>
	);
}
