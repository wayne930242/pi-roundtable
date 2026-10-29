import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	expect,
	test,
} from "bun:test";
import { partial } from "pi-roundtable/testing";
import type {
	ClientFrame,
	ConfigView,
	HostCardView,
	ReadMarkView,
	RoomMessage,
} from "../src/api-types.ts";
import type {
	HostListView,
	HostPageView,
	HostRoomView,
} from "../src/host/views.ts";
import HostKindSection from "./components/host-kind-section.tsx";
import ReadLog from "./components/read-log.tsx";
import { openPage, releaseDom, type TestPage } from "./dom.ts";
import { store } from "./lib/app-store.ts";
import { ConfigContext } from "./lib/config.ts";
import * as hostState from "./lib/host-state.ts";
import type { PageRouteProps } from "./lib/page-routes.ts";
import { setRouting } from "./lib/router.ts";
import { type AppConnection, setConnection } from "./lib/socket.ts";
import { HostPage } from "./pages/host-page.tsx";
import { HostRoomPage } from "./pages/host-room.tsx";

const KIND = "inbox";
// What the shell gives a page of the registry: the route's second part (and, once merged with the notices, its first).
const pageProps = { routeKey: "mailboxes" } as PageRouteProps;
const ID = "thread-aaaa0001";
const ROOM = `app:${KIND}.${ID}`;
const ME = "p-ada";

const config: ConfigView = {
	title: "Support",
	panes: ["rooms"],
	timeZone: "UTC",
	look: "modern",
	app: { surface: "app", protocol: "p" },
	kinds: [{ kind: KIND, label: "Support inbox" }],
};

const message = (id: number, over: Partial<RoomMessage> = {}): RoomMessage => ({
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

const OPEN_CARD: HostCardView = {
	id: "c1",
	room: ROOM,
	title: "Draft ready",
	body: "Hi Dana",
	state: "open",
	buttons: [{ id: "send", label: "Send reply" }],
	at: "2026-10-29T10:00:00.000Z",
	updatedAt: "2026-10-29T10:00:00.000Z",
};

interface Fixture {
	view: HostRoomView | undefined;
	list: HostListView;
	pageView: HostPageView;
	requests: { url: string; method: string; body?: unknown }[];
	acts: { ok: boolean; notice?: string; error?: string }[];
}

const fixture: Fixture = {
	view: undefined,
	list: { kind: KIND, label: "Support inbox", rooms: [] },
	pageView: { id: "mailboxes", title: "Mailboxes", sections: [] },
	requests: [],
	acts: [],
};

const roomView = (over: Partial<HostRoomView> = {}): HostRoomView => ({
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

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});

const realFetch = globalThis.fetch;
function installFetch(): void {
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

const sent: ClientFrame[] = [];
const said: { room: string; text: string; mode?: "note" | "turn" }[] = [];
const focused: (string | undefined)[] = [];

let page: TestPage;
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

const settle = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));
const shown = (node: React.ReactNode) =>
	page.render(
		<ConfigContext.Provider value={config}>{node}</ConfigContext.Provider>,
	);
const buttonNamed = (text: string) =>
	[...page.container.querySelectorAll("button")].find(
		(button) =>
			button.textContent?.trim() === text ||
			button.getAttribute("aria-label") === text,
	) ?? null;

test("a host room shows its header, each author as itself, and its open card, and follows the room's frames while it is open", async () => {
	await shown(<HostRoomPage roomKey={ROOM} />);
	await settle();
	const html = page.container.innerHTML;
	expect(page.container.querySelector("h1")?.textContent).toBe("Invoice 4410");
	expect(html).toContain("Written twice today");
	expect(
		page.container.querySelector('a[href="https://example.com/o/4410"]'),
	).not.toBeNull();
	// An outside party's text stays text; the assistant's is Markdown; the notice is a line of its own.
	expect(
		page.container.querySelector('[data-author="external"] .bubble')
			?.textContent,
	).toContain("<b>Hi</b>");
	expect(
		page.container
			.querySelector('[data-author="external"] a')
			?.getAttribute("href"),
	).toBe("https://example.com");
	expect(
		page.container.querySelector('[data-author="assistant"] .bubble strong')
			?.textContent,
	).toBe("checked");
	expect(page.container.querySelector(".host-notice strong")?.textContent).toBe(
		"Mel",
	);
	expect(
		page.container
			.querySelector('[data-author="member"]')
			?.getAttribute("data-mine"),
	).toBe("true");
	// The strip of cards starts folded where the screen is small, with the waiting card named.
	expect(buttonNamed("1 card waiting: Draft ready")).not.toBeNull();
	expect(page.container.querySelector(".host-card")).toBeNull();
	await page.click(buttonNamed("1 card waiting: Draft ready"));
	expect(page.container.querySelector(".host-card h3")?.textContent).toBe(
		"Draft ready",
	);
	expect(buttonNamed("Send reply")).not.toBeNull();
	// The page follows the room and shows its progress.
	expect(sent).toContainEqual({ type: "subscribe", room: ROOM });
	expect(focused.at(-1)).toBe(ROOM);
	await page.render(null);
	expect(sent).toContainEqual({ type: "unsubscribe", room: ROOM });
	expect(focused.at(-1)).toBeUndefined();
});

test("on a wide screen the strip of cards starts open", async () => {
	window.innerWidth = 1280;
	window.innerHeight = 900;
	await shown(<HostRoomPage roomKey={ROOM} />);
	await settle();
	expect(page.container.querySelector(".host-card h3")?.textContent).toBe(
		"Draft ready",
	);
});

test("a person who may send both ways chooses a note or a turn, and the message goes the way chosen", async () => {
	await shown(<HostRoomPage roomKey={ROOM} />);
	await settle();
	const write = async (text: string) => {
		const box = page.container.querySelector("textarea");
		await page.act(() => {
			const setter = Object.getOwnPropertyDescriptor(
				HTMLTextAreaElement.prototype,
				"value",
			)?.set;
			setter?.call(box, text);
			box?.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await page.click(buttonNamed("Send"));
		await settle();
	};
	await write("for the agent");
	await page.click(buttonNamed("Note"));
	await write("for the team");
	expect(said).toEqual([
		{ room: ROOM, text: "for the agent", mode: "turn" },
		{ room: ROOM, text: "for the team", mode: "note" },
	]);
});

test("a person who may only read has no box, and one who may only write notes has no choice", async () => {
	fixture.view = roomView({ access: { send: [], act: false } });
	await shown(<HostRoomPage roomKey={ROOM} />);
	await settle();
	expect(page.container.querySelector("textarea")).toBeNull();
	expect(page.container.textContent).toContain(
		"You can read this room but not write in it.",
	);
	await page.render(null);
	fixture.view = roomView({ access: { send: ["note"], act: true } });
	await shown(<HostRoomPage roomKey={ROOM} />);
	await settle();
	expect(buttonNamed("Ask the agent")).toBeNull();
	expect(page.container.querySelector("textarea")).not.toBeNull();
});

test("a room that is not there for this person says so and follows nothing", async () => {
	fixture.view = undefined;
	await shown(<HostRoomPage roomKey={ROOM} />);
	await settle();
	expect(page.container.textContent).toContain("This room is not available.");
	expect(sent.filter((frame) => frame.type === "subscribe")).toEqual([]);
});

test("a header action asks first, then reaches the host with the card it came from left out", async () => {
	fixture.acts.push({ ok: true, notice: "Closed." });
	await shown(<HostRoomPage roomKey={ROOM} />);
	await settle();
	await page.click(buttonNamed("Close thread"));
	expect(page.container.ownerDocument.body.textContent).toContain("Close it?");
	const confirm = [...document.querySelectorAll("button")].filter(
		(button) => button.textContent?.trim() === "Close thread",
	);
	await page.click(confirm.at(-1) ?? null);
	await settle();
	expect(fixture.requests.at(-1)).toMatchObject({
		method: "POST",
		body: { action: "close", input: {} },
	});
	expect(fixture.requests.at(-1)?.body).not.toHaveProperty("card");
});

test("a card's button carries the card's id", async () => {
	await shown(<HostRoomPage roomKey={ROOM} />);
	await settle();
	await page.click(buttonNamed("1 card waiting: Draft ready"));
	await page.click(buttonNamed("Send reply"));
	await settle();
	expect(fixture.requests.at(-1)?.body).toMatchObject({
		action: "send",
		card: "c1",
	});
});

// ── The new-messages divider, the marks of who has read, and telling the server how far the person has read ───

const ROOM2 = "app:inbox.marks-room-0001";

function loadMessages(): RoomMessage[] {
	const messages = [1, 2, 3, 4, 5].map((id) =>
		message(id, {
			room: ROOM2,
			authorKind: "external",
			...(id === 4 ? { authorKind: "member", principalId: ME } : {}),
		}),
	);
	store.dispatch({
		type: "history_loaded",
		room: ROOM2,
		messages,
		more: false,
		older: false,
	});
	return messages;
}

test("a divider stands where the new messages began, and each reader's mark under the last message they read", async () => {
	loadMessages();
	const marks: ReadMarkView[] = [
		{
			principal: "p-mel",
			name: "Mel",
			upTo: 3,
			at: "2026-10-29T10:00:00.000Z",
		},
		{
			principal: "p-kim",
			name: "Kim",
			upTo: 3,
			at: "2026-10-29T10:00:01.000Z",
		},
		{ principal: ME, name: "Ada", upTo: 5, at: "2026-10-29T10:00:02.000Z" },
	];
	hostState.keepReads(ROOM2, marks, 2);
	const scroller = { current: null as HTMLElement | null };
	await shown(
		<div
			ref={(element) => {
				scroller.current = element;
			}}
		>
			<ReadLog
				roomKey={ROOM2}
				enterAfter={undefined}
				quotable={false}
				scroller={scroller}
				host
			/>
		</div>,
	);
	const order = [...page.container.querySelectorAll(".messages > li")].map(
		(item) =>
			item.classList.contains("new-divider")
				? "divider"
				: item.classList.contains("seen")
					? "seen"
					: (item.getAttribute("data-mid") ?? "?"),
	);
	// The cursor was 2: the divider goes before message 3, and the two readers of 3 are shown under it, the person themselves not.
	expect(order.slice(order.indexOf("divider"))).toEqual([
		"divider",
		"3",
		"seen",
		"4",
		"5",
	]);
	expect(page.container.querySelector(".seen")?.textContent).toContain(
		"Seen by 2",
	);
	await page.click(page.container.querySelector(".seen-toggle"));
	expect(page.container.querySelector(".seen-names")?.textContent).toBe(
		"Mel, Kim",
	);
});

const rects = new Map<string, { top: number; bottom: number }>();
function pretendLayout(): () => void {
	const realRect = HTMLElement.prototype.getBoundingClientRect;
	HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
		const at =
			this.dataset.mid !== undefined
				? rects.get(this.dataset.mid)
				: this.dataset.scroller !== undefined
					? { top: 0, bottom: 300 }
					: undefined;
		return {
			top: 0,
			bottom: 0,
			left: 0,
			right: 0,
			width: 0,
			height: 0,
			x: 0,
			y: 0,
			...at,
			toJSON: () => ({}),
		} as DOMRect;
	};
	return () => {
		HTMLElement.prototype.getBoundingClientRect = realRect;
	};
}

test("the server is told how far the person has read: the newest message in view, once a second at most, and never while the page is hidden", async () => {
	const restore = pretendLayout();
	try {
		const room = "app:inbox.track-room-0001";
		store.dispatch({
			type: "history_loaded",
			room,
			messages: [1, 2, 3, 4].map((id) => message(id, { room })),
			more: false,
			older: false,
		});
		rects.clear();
		// The viewport is 0–300: messages 1 and 2 are in it, 3 and 4 are below.
		rects.set("1", { top: 10, bottom: 60 });
		rects.set("2", { top: 100, bottom: 150 });
		rects.set("3", { top: 320, bottom: 370 });
		rects.set("4", { top: 400, bottom: 450 });
		const scroller = { current: null as HTMLElement | null };
		await shown(
			<div
				data-scroller=""
				ref={(element) => {
					scroller.current = element;
				}}
			>
				<ReadLog
					roomKey={room}
					enterAfter={undefined}
					quotable={false}
					scroller={scroller}
					host
				/>
			</div>,
		);
		await settle(60);
		const reads = () => sent.filter((frame) => frame.type === "read");
		expect(reads()).toEqual([{ type: "read", room, upTo: 2 }]);
		// Scrolling down brings 3 and 4 into view; the next report waits out the second.
		rects.set("3", { top: 120, bottom: 170 });
		rects.set("4", { top: 200, bottom: 250 });
		await page.act(() => {
			scroller.current?.dispatchEvent(new Event("scroll"));
		});
		await settle(100);
		expect(reads()).toHaveLength(1);
		await settle(1000);
		expect(reads().at(-1)).toEqual({ type: "read", room, upTo: 4 });
		expect(reads()).toHaveLength(2);
		// A hidden page reads nothing.
		Object.defineProperty(document, "visibilityState", {
			value: "hidden",
			configurable: true,
		});
		store.dispatch({ type: "message", room, message: message(5, { room }) });
		rects.set("5", { top: 260, bottom: 290 });
		await settle(1200);
		expect(reads()).toHaveLength(2);
	} finally {
		Object.defineProperty(document, "visibilityState", {
			value: "visible",
			configurable: true,
		});
		restore();
	}
});

// ── The list of a kind, and a page ────────────────────────────────────────────────────────────────

test("the list of a kind shows each room with its picture, what needs attention and its unread count, and searches on the host's side", async () => {
	fixture.list = {
		kind: KIND,
		label: "Support inbox",
		rooms: [
			{
				id: ID,
				key: ROOM,
				title: "Invoice 4410",
				subtitle: "Dana",
				picture: { initials: "D", color: "#a04b3a" },
				attention: true,
				unread: 3,
				lastAt: "2026-10-29T10:00:00.000Z",
			},
			...[1, 2, 3, 4, 5].map((n) => ({
				id: `thread-bbbb000${n}`,
				key: `app:inbox.thread-bbbb000${n}`,
				title: `Order ${n}`,
			})),
		],
		cursor: "next-page",
	};
	await shown(
		<HostKindSection kind={KIND} label="Support inbox" active={ROOM} />,
	);
	await settle();
	const rows = [...page.container.querySelectorAll(".room-row")];
	expect(rows).toHaveLength(6);
	expect(rows[0]?.getAttribute("aria-current")).toBe("page");
	expect(rows[0]?.querySelector(".hpic")?.textContent).toBe("D");
	expect(rows[0]?.querySelector(".attention-dot")).not.toBeNull();
	expect(rows[0]?.querySelector(".unread-mark")?.textContent).toBe("3");
	expect(rows[1]?.querySelector(".unread-mark")).toBeNull();
	expect(buttonNamed("Show more")).not.toBeNull();
	// More than a handful of rooms bring a search box, and a search asks the host.
	const search = page.container.querySelector('input[type="search"]');
	await page.act(() => {
		const setter = Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value",
		)?.set;
		setter?.call(search, "dana");
		search?.dispatchEvent(new Event("input", { bubbles: true }));
	});
	// The search goes out once typing pauses; wait for it rather than for a fixed time.
	// Each wait is inside `act`: React's scheduler may have been loaded under an earlier file's DOM, which is gone, so a state change outside `act` is never flushed.
	for (let waited = 0; waited < 2000; waited += 50) {
		if (fixture.requests.some((request) => request.url.includes("filter=dana")))
			break;
		await page.act(async () => {
			await settle(50);
		});
	}
	expect(
		fixture.requests.some((request) => request.url.includes("filter=dana")),
	).toBe(true);
});

test("a host page shows its sections, runs a form's action, and tells the person what the host answered", async () => {
	fixture.pageView = {
		id: "mailboxes",
		title: "Mailboxes",
		sections: [
			{ kind: "markdown", text: "Mailboxes the inbox **reads**." },
			{
				kind: "list",
				title: "Connected",
				rows: [
					{
						title: "support@example.com",
						subtitle: "Synced",
						actions: [{ id: "remove", label: "Remove" }],
					},
					{
						title: "billing@example.com",
						attention: true,
						open: "https://example.com/mail",
					},
				],
			},
			{
				kind: "form",
				action: "connect",
				form: {
					title: "Connect a mailbox",
					submit: "Connect",
					fields: [
						{ name: "address", label: "Address", type: "text", required: true },
					],
				},
			},
			{
				kind: "card",
				card: { title: "Heads up", body: "Check the DNS", state: "done" },
			},
		],
	};
	await shown(<HostPage {...pageProps} />);
	await settle();
	expect(page.container.querySelector("h1")?.textContent).toBe("Mailboxes");
	expect(page.container.querySelector(".prose strong")?.textContent).toBe(
		"reads",
	);
	expect(page.container.querySelectorAll(".host-list > li")).toHaveLength(2);
	expect(
		page.container.querySelector(
			'.host-list a[href="https://example.com/mail"]',
		),
	).not.toBeNull();
	expect(
		page.container.querySelector(".host-card")?.getAttribute("data-state"),
	).toBe("done");
	const input = page.container.querySelector('input[type="text"]');
	await page.act(() => {
		const setter = Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value",
		)?.set;
		setter?.call(input, "ops@example.com");
		input?.dispatchEvent(new Event("input", { bubbles: true }));
	});
	await page.act(() => {
		page.container
			.querySelector("form")
			?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
	});
	await settle();
	expect(
		fixture.requests.find((request) =>
			request.url.includes("pages/mailboxes/act"),
		),
	).toMatchObject({
		method: "POST",
		body: { action: "connect", input: { address: "ops@example.com" } },
	});
});

test("a page the viewer may not see is not available", async () => {
	const original = fixture.pageView;
	fixture.pageView = undefined as never;
	globalThis.fetch = (async () =>
		json({ error: "There is no such page." }, 404)) as unknown as typeof fetch;
	try {
		await shown(<HostPage {...pageProps} />);
		await settle();
		expect(page.container.textContent).toContain("This page is not available.");
	} finally {
		fixture.pageView = original;
		installFetch();
	}
});
