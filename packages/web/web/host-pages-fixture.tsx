import { afterAll, afterEach, beforeAll, beforeEach } from "bun:test";
import { partial } from "pi-roundtable/testing";
import type {
	ClientFrame,
	ConfigView,
	HostCardView,
	RoomMessage,
} from "../src/api-types.ts";
import type {
	HostListView,
	HostPageView,
	HostRoomView,
} from "../src/host/views.ts";
import { openPage, releaseDom, type TestPage } from "./dom.ts";
import { store } from "./lib/app-store.ts";
import { ConfigContext } from "./lib/config.ts";
import type { PageRouteProps } from "./lib/page-routes.ts";
import { setRouting } from "./lib/router.ts";
import { type AppConnection, setConnection } from "./lib/socket.ts";

export const KIND = "inbox";
// What the shell gives a page of the registry: the route's second part (and, once merged with the notices, its first).
export const pageProps = { routeKey: "mailboxes" } as PageRouteProps;
export const ID = "thread-aaaa0001";
export const ROOM = `app:${KIND}.${ID}`;
export const ME = "p-ada";

export const config: ConfigView = {
	title: "Support",
	panes: ["rooms"],
	timeZone: "UTC",
	look: "modern",
	app: { surface: "app", protocol: "p" },
	kinds: [{ kind: KIND, label: "Support inbox" }],
};

export const message = (
	id: number,
	over: Partial<RoomMessage> = {},
): RoomMessage => ({
	id,
	room: ROOM,
	kind: "owner",
	author: "Dana",
	text: `message ${id}`,
	files: [],
	at: "2026-10-29T10:00:00.000Z",
	authorKind: "external",
	authorLabel: "Customer",
	...over,
});

export const OPEN_CARD: HostCardView = {
	id: "c1",
	room: ROOM,
	title: "Draft ready",
	body: "Hi Dana",
	state: "open",
	buttons: [{ id: "send", label: "Send reply" }],
	at: "2026-10-29T10:00:00.000Z",
	updatedAt: "2026-10-29T10:00:00.000Z",
};

export interface Fixture {
	view: HostRoomView | undefined;
	list: HostListView;
	pageView: HostPageView;
	requests: { url: string; method: string; body?: unknown }[];
	acts: { ok: boolean; notice?: string; error?: string }[];
}

export const fixture: Fixture = {
	view: undefined,
	list: { kind: KIND, label: "Support inbox", rooms: [] },
	pageView: { id: "mailboxes", title: "Mailboxes", sections: [] },
	requests: [],
	acts: [],
};

export const roomView = (over: Partial<HostRoomView> = {}): HostRoomView => ({
	room: ROOM,
	kind: KIND,
	id: ID,
	access: { send: ["note", "turn"], act: true },
	header: {
		title: "Invoice 4410",
		fields: [
			{ label: "From", value: "Dana" },
			{ label: "Order", value: "#4410", link: "https://example.com/o/4410" },
		],
		actions: [
			{
				id: "close",
				label: "Close thread",
				style: "danger",
				confirm: "Close it?",
			},
		],
		banner: { tone: "warn", text: "Written twice today" },
	},
	messages: [
		message(1, { text: "<b>Hi</b> https://example.com" }),
		message(2, {
			authorKind: "notice",
			kind: "system",
			text: "Assigned to **Mel**",
		}),
		message(3, {
			authorKind: "assistant",
			kind: "agent",
			author: "Atlas",
			text: "I **checked**",
		}),
		message(4, {
			authorKind: "member",
			principalId: ME,
			author: "Ada",
			text: "On it",
		}),
	],
	more: false,
	cards: [OPEN_CARD],
	reads: [],
	cursor: 4,
	...over,
});

export const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});

export const realFetch = globalThis.fetch;
export function installFetch(): void {
	globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
		const url = String(input);
		const method = init?.method ?? "GET";
		const body = init?.body ? JSON.parse(String(init.body)) : undefined;
		fixture.requests.push({ url, method, ...(body ? { body } : {}) });
		if (url.includes(`host/${KIND}/${ID}/act`))
			return json(fixture.acts.shift() ?? { ok: true });
		if (url.includes(`host/${KIND}/${ID}`))
			return fixture.view
				? json(fixture.view)
				: json({ error: "There is no such room." }, 404);
		if (url.includes(`host/${KIND}`)) return json(fixture.list);
		if (url.includes("pages/mailboxes/act"))
			return json({ ok: true, notice: "Connected." });
		if (url.includes("pages/mailboxes")) return json(fixture.pageView);
		return json({}, 404);
	}) as typeof fetch;
}

export const sent: ClientFrame[] = [];
export const said: { room: string; text: string; mode?: "note" | "turn" }[] =
	[];
export const focused: (string | undefined)[] = [];

export let page: TestPage;

export const settle = (ms = 40) =>
	new Promise((resolve) => setTimeout(resolve, ms));
export const shown = (node: React.ReactNode) =>
	page.render(
		<ConfigContext.Provider value={config}>{node}</ConfigContext.Provider>,
	);
export const buttonNamed = (text: string) =>
	[...page.container.querySelectorAll("button")].find(
		(button) =>
			button.textContent?.trim() === text ||
			button.getAttribute("aria-label") === text,
	) ?? null;

/** Registers the setup and cleanup hooks of the suites. */
export function hostPagesPage(): void {
	beforeAll(async () => {
		page = await openPage();
		setRouting(undefined);
		installFetch();
		setConnection(
			partial<AppConnection>({
				send: (frame: ClientFrame) => {
					sent.push(frame);
					return true;
				},
				focus: (room: string | undefined) => {
					focused.push(room);
				},
				say: (
					room: string,
					text: string,
					_files: unknown,
					mode?: "note" | "turn",
				) => {
					said.push({ room, text, ...(mode ? { mode } : {}) });
				},
			}),
		);
	});
	afterAll(async () => {
		setConnection(undefined);
		globalThis.fetch = realFetch;
		await page.unmount();
		await releaseDom();
	});
	beforeEach(() => {
		// A phone, where the strip of cards starts folded.
		window.innerWidth = 390;
		window.innerHeight = 844;
		fixture.view = roomView();
		fixture.requests.length = 0;
		fixture.acts.length = 0;
		sent.length = 0;
		said.length = 0;
		focused.length = 0;
		store.dispatch({
			type: "ready",
			protocol: 1,
			principal: ME,
			name: "Ada",
			uploads: { perMessage: 4, maxBytes: 1000 },
		});
	});
	afterEach(async () => {
		await page.render(null);
	});
}
