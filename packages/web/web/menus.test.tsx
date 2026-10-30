import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	expect,
	spyOn,
	test,
} from "bun:test";
import { partial } from "pi-roundtable/testing";
import type {
	ConfigView,
	PromptFrame,
	RoomFile,
	RoomMessage,
	RoomView,
} from "../src/api-types.ts";
import { ActionMenuHost } from "./components/action-menu.tsx";
import { PromptCard } from "./components/cards.tsx";
import { Composer } from "./components/composer.tsx";
import { MessageRow } from "./components/message-row.tsx";
import { RoomConfirmHost } from "./components/room-confirms.tsx";
import { RoomSwitcher, useSwitcher } from "./components/switcher.tsx";
import { Toaster } from "./components/toaster.tsx";
import { openPage, releaseDom, type TestPage } from "./dom.ts";
import { closeMenu } from "./lib/action-menu.ts";
import { closeAgentSheet, currentAgentSheet } from "./lib/agent-sheet.ts";
import { api } from "./lib/api.ts";
import { store } from "./lib/app-store.ts";
import { ConfigContext } from "./lib/config.ts";
import { clearDrafts, draftOf } from "./lib/drafts.ts";
import { loadKit } from "./lib/kit.ts";
import { setRouting } from "./lib/router.ts";
import { type AppConnection, setConnection } from "./lib/socket.ts";
import { RoomsPage } from "./pages/rooms.tsx";

const SCOUT = "app:agent.scout";
const TEAM = "app:group.team";
const WORK = "app:thread.0b5e7c1a-0000-4000-8000-000000000001";

const config: ConfigView = {
	title: "Console",
	panes: ["rooms"],
	timeZone: "UTC",
	look: "modern",
};

const view = (key: string, over: Partial<RoomView> = {}): RoomView => ({
	key,
	kind: "agent",
	name: key.slice(key.indexOf(".") + 1),
	displayName: key.slice(key.indexOf(".") + 1),
	home: false,
	readOnly: false,
	mode: { yolo: false, longRunning: false },
	typing: false,
	stoppable: false,
	...over,
});

const said = (over: Partial<RoomMessage> = {}): RoomMessage => ({
	id: 7,
	room: SCOUT,
	kind: "agent",
	agent: "scout",
	author: "Scout",
	text: "hello **bold**\nsecond line",
	files: [],
	at: "2026-10-28T10:00:00.000Z",
	...over,
});

let page: TestPage;
beforeAll(async () => {
	await loadKit();
	page = await openPage();
	setRouting(undefined);
	setConnection(partial<AppConnection>({ send: () => true }));
});
afterAll(async () => {
	setConnection(undefined);
	await page.unmount();
	await releaseDom();
});

const settle = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
	window.innerWidth = 1280;
	window.location.hash = "#/rooms";
	store.dispatch({
		type: "rooms_loaded",
		rooms: [
			view(SCOUT, { last: said() }),
			view(TEAM, { kind: "group", members: ["scout"] }),
			view(WORK, {
				kind: "thread",
				name: "thread.0b5e7c1a-0000-4000-8000-000000000001",
				displayName: "Check the logs",
				parent: SCOUT,
				readOnly: true,
			}),
		],
	});
});
afterEach(async () => {
	await page.act(() => closeMenu());
	await page.render(null);
	store.dispatch({ type: "rooms_loaded", rooms: [] });
	clearDrafts();
	closeAgentSheet();
	Reflect.deleteProperty(navigator, "share");
	Reflect.deleteProperty(navigator, "canShare");
});

const rightClick = async (target: Element | null, opens = true) => {
	if (!target) throw new Error("nothing to click");
	// The menu's builders load on demand, so the menu is there a moment after the click: the first
	// one waits for the chunk, however busy the machine is. The wait is outside `act`, which holds
	// React's updates back until it returns, so the loop would never see the menu inside it.
	await page.act(async () => {
		target.dispatchEvent(
			new MouseEvent("contextmenu", {
				bubbles: true,
				cancelable: true,
				clientX: 120,
				clientY: 80,
			}),
		);
		await settle(30);
	});
	const stop = Date.now() + 3000;
	while (
		opens &&
		!document.querySelector('[role^="menuitem"]') &&
		Date.now() < stop
	)
		await page.act(async () => {
			await settle(20);
		});
};
const menuItems = (): HTMLElement[] => [
	...document.querySelectorAll<HTMLElement>('[role^="menuitem"]'),
];
const labels = () => menuItems().map((one) => one.textContent);
const checked = (label: string) =>
	menuItems()
		.find((one) => one.textContent === label)
		?.getAttribute("aria-checked");
const choose = async (label: string) => {
	const item = menuItems().find((one) => one.textContent === label);
	if (!item) throw new Error(`no menu item ${label}: ${labels().join(", ")}`);
	await page.click(item);
	await settle(80);
};
const q = <T extends Element = HTMLElement>(selector: string): T | null =>
	document.querySelector<T>(selector);
const rowOf = (name: string) =>
	[...document.querySelectorAll<HTMLElement>(".room-row")].find((one) =>
		one.textContent?.includes(name),
	) ?? null;

function copied(): string[] {
	const written: string[] = [];
	Object.defineProperty(navigator, "clipboard", {
		value: {
			writeText: (text: string) => {
				written.push(text);
				return Promise.resolve();
			},
		},
		configurable: true,
	});
	return written;
}

const List = () => (
	<ConfigContext.Provider value={config}>
		<RoomsPage onSearch={() => undefined} />
		<ActionMenuHost />
		<RoomConfirmHost />
		<Toaster />
	</ConfigContext.Provider>
);

// ── Agent and group rows ─────────────────────────────────────────────────────────────────────

test("an agent row's menu has the edit, look, notifications, mode and restart actions that work today", async () => {
	await page.render(<List />);
	await rightClick(rowOf("scout"));
	expect(labels()).toEqual([
		"Pin",
		"Move to folder…",
		"Edit knight",
		"Change look",
		"Notifications",
		"Yolo mode",
		"Long-running mode",
		"Start over",
		"Archive knight",
	]);
	expect(q("[role=menu]")?.getAttribute("aria-label")).toBe("scout");
	expect(rowOf("scout")?.getAttribute("data-hold")).toBe("row");
});

test("a group row has the modes and restart but no agent edit; a thread row has no menu", async () => {
	await page.render(<List />);
	await rightClick(rowOf("team"));
	expect(labels()).toEqual([
		"Pin",
		"Move to folder…",
		"Edit group",
		"Notifications",
		"Yolo mode",
		"Long-running mode",
		"Start over",
		"Archive group",
	]);
	await page.act(() => closeMenu());
	await rightClick(q(".thread-card"), false);
	expect(labels()).toEqual([]);
});

test("Edit knight opens the knight sheet; Change look opens it at the character creator", async () => {
	await page.render(<List />);
	await rightClick(rowOf("scout"));
	await choose("Edit knight");
	expect(currentAgentSheet()).toMatchObject({ name: "scout", look: false });
	// The sheet is over the page, not a page of its own.
	expect(window.location.hash).toBe("#/rooms");

	closeAgentSheet();
	await rightClick(rowOf("scout"));
	await choose("Change look");
	expect(currentAgentSheet()).toMatchObject({ name: "scout", look: true });
	expect(window.location.hash).toBe("#/rooms");
});

test("the notifications item shows whether the room is pushed and flips it through the server", async () => {
	const setMute = spyOn(api, "setMute").mockResolvedValue({ muted: true });
	try {
		await page.render(<List />);
		await rightClick(rowOf("scout"));
		expect(checked("Notifications")).toBe("true");
		await choose("Notifications");
		expect(setMute).toHaveBeenCalledWith(SCOUT, true);
		// The list shows the bell-slash as soon as the server has said so.
		expect(store.getState().rooms[SCOUT]?.view?.muted).toBe(true);
		expect(
			rowOf("scout")
				?.querySelector("svg[aria-label]")
				?.getAttribute("aria-label"),
		).toBe("Notifications are off");
		expect(document.body.textContent).toContain(
			"Notifications are off for scout",
		);

		setMute.mockResolvedValue({ muted: false });
		await rightClick(rowOf("scout"));
		expect(checked("Notifications")).toBe("false");
		await choose("Notifications");
		expect(setMute).toHaveBeenLastCalledWith(SCOUT, false);
		expect(store.getState().rooms[SCOUT]?.view?.muted).toBeUndefined();
		expect(rowOf("scout")?.querySelector("svg[aria-label]")).toBeNull();
	} finally {
		setMute.mockRestore();
	}
});

test("a mute the server refuses leaves the room as it was and says so", async () => {
	const setMute = spyOn(api, "setMute").mockRejectedValue(
		new Error("Only an owner may do this."),
	);
	try {
		await page.render(<List />);
		await rightClick(rowOf("scout"));
		await choose("Notifications");
		expect(store.getState().rooms[SCOUT]?.view?.muted).toBeUndefined();
		expect(document.body.textContent).toContain("Only an owner may do this.");
	} finally {
		setMute.mockRestore();
	}
});

test("the long-running item flips the mode through changeMode; yolo off does too", async () => {
	const setMode = spyOn(api, "setMode").mockResolvedValue(undefined as never);
	try {
		await page.render(<List />);
		await rightClick(rowOf("scout"));
		expect(checked("Long-running mode")).toBe("false");
		await choose("Long-running mode");
		expect(setMode).toHaveBeenCalledWith(SCOUT, { longRunning: true });

		store.dispatch({
			type: "mode",
			room: SCOUT,
			yolo: true,
			longRunning: false,
		});
		await rightClick(rowOf("scout"));
		expect(checked("Yolo mode")).toBe("true");
		await choose("Yolo mode");
		expect(setMode).toHaveBeenLastCalledWith(SCOUT, { yolo: false });
	} finally {
		setMode.mockRestore();
	}
});

test("turning yolo on asks first, with the same confirm as the room menu, and then sets it", async () => {
	const setMode = spyOn(api, "setMode").mockResolvedValue(undefined as never);
	try {
		await page.render(<List />);
		await rightClick(rowOf("scout"));
		await choose("Yolo mode");
		expect(setMode).not.toHaveBeenCalled();
		const dialog = [...document.querySelectorAll("dialog")].find(
			(one) =>
				one.open && one.getAttribute("aria-label") === "Turn on yolo mode?",
		);
		expect(dialog).toBeDefined();
		const confirm = [...(dialog?.querySelectorAll("button") ?? [])].find(
			(one) => one.textContent === "Turn on yolo mode",
		);
		await page.click(confirm ?? null);
		expect(setMode).toHaveBeenCalledWith(SCOUT, { yolo: true });
	} finally {
		setMode.mockRestore();
	}
});

test("Start over asks with its confirm, and restarts the room when confirmed", async () => {
	const startOver = spyOn(api, "startRoomOver").mockResolvedValue(
		undefined as never,
	);
	try {
		await page.render(<List />);
		await rightClick(rowOf("scout"));
		await choose("Start over");
		expect(startOver).not.toHaveBeenCalled();
		const dialog = [...document.querySelectorAll("dialog")].find(
			(one) =>
				one.open && one.getAttribute("aria-label") === "Start over scout?",
		);
		expect(dialog).toBeDefined();
		const confirm = [...(dialog?.querySelectorAll("button") ?? [])].find(
			(one) => one.textContent === "Start over",
		);
		await page.click(confirm ?? null);
		expect(startOver).toHaveBeenCalledWith(SCOUT);
	} finally {
		startOver.mockRestore();
	}
});

function DrawerRoom() {
	const switcher = useSwitcher(true);
	return (
		<>
			<button type="button" id="avatar" onClick={switcher.show}>
				avatar
			</button>
			<RoomSwitcher {...switcher.drawer} current={TEAM} />
		</>
	);
}

test("a row of the phone drawer opens the same menu as a sheet; an action that leaves the room closes the drawer first", async () => {
	window.innerWidth = 390;
	await page.render(
		<>
			<DrawerRoom />
			<ActionMenuHost />
		</>,
	);
	await page.click(q("#avatar"));
	expect(q(".switcher")?.getAttribute("data-state")).toBe("open");
	// The rows are a chunk of their own, drawn a moment after the drawer opens.
	const stop = Date.now() + 3000;
	while (!q(".switcher-row[href*='scout']") && Date.now() < stop)
		await page.act(async () => {
			await settle(20);
		});
	await rightClick(q(".switcher-row[href*='scout']"));
	expect(q("dialog.sheet")?.hasAttribute("open")).toBe(true);
	expect(labels()).toContain("Edit knight");
	await choose("Edit knight");
	await settle(300);
	expect(currentAgentSheet()).toMatchObject({ name: "scout", look: false });
	expect(q(".switcher")?.getAttribute("data-state")).toBe("closed");
});

// ── Messages ─────────────────────────────────────────────────────────────────────────────────

const Message = (props: {
	message?: RoomMessage;
	quotable?: boolean;
	composer?: boolean;
}) => (
	<ConfigContext.Provider value={config}>
		<ul>
			<MessageRow
				message={props.message ?? said()}
				character={undefined}
				header
				enter={false}
				timeZone="UTC"
				quotable={props.quotable ?? true}
			/>
		</ul>
		{props.composer ? (
			<Composer
				draftKey={SCOUT}
				name="scout"
				limits={undefined}
				stoppable={false}
				onSend={() => undefined}
				onStop={() => undefined}
			/>
		) : null}
		<ActionMenuHost />
	</ConfigContext.Provider>
);

test("a message's menu: copy, copy as Markdown, quote, select, and share when the browser can", async () => {
	await page.render(<Message />);
	await rightClick(q("li.message"));
	expect(labels()).toEqual([
		"Copy",
		"Copy as Markdown",
		"Quote reply",
		"Select text",
	]);
	await page.act(() => closeMenu());
	Object.defineProperty(navigator, "share", {
		value: () => Promise.resolve(),
		configurable: true,
	});
	await rightClick(q("li.message"));
	expect(labels()).toEqual([
		"Copy",
		"Copy as Markdown",
		"Quote reply",
		"Select text",
		"Share",
	]);
	expect(q("li.message")?.getAttribute("data-hold")).toBe("text");
});

test("Copy puts the message's words on the clipboard; Copy as Markdown puts its source", async () => {
	const written = copied();
	await page.render(<Message />);
	await rightClick(q("li.message"));
	await choose("Copy");
	expect(written[0]).toContain("hello bold");
	expect(written[0]).not.toContain("**");
	await rightClick(q("li.message"));
	await choose("Copy as Markdown");
	expect(written[1]).toBe("hello **bold**\nsecond line");
});

test("Quote reply puts the message as a quote into the room's message box, below what is there", async () => {
	await page.render(<Message composer />);
	const box = q<HTMLTextAreaElement>("textarea");
	await rightClick(q("li.message"));
	await choose("Quote reply");
	expect(draftOf(SCOUT)).toBe("> hello **bold**\n> second line\n\n");
	expect(box?.value).toBe("> hello **bold**\n> second line\n\n");
	expect(document.activeElement).toBe(box);

	await page.act(() => {
		if (box) {
			Object.getOwnPropertyDescriptor(
				HTMLTextAreaElement.prototype,
				"value",
			)?.set?.call(box, "my take");
			box.dispatchEvent(new Event("input", { bubbles: true }));
		}
	});
	await rightClick(q("li.message"));
	await choose("Quote reply");
	expect(draftOf(SCOUT)).toBe("my take\n\n> hello **bold**\n> second line\n\n");
});

test("with no message box on the page the quote waits in the room's draft", async () => {
	await page.render(<Message />);
	await rightClick(q("li.message"));
	await choose("Quote reply");
	expect(draftOf(SCOUT)).toBe("> hello **bold**\n> second line\n\n");
});

test("a message of a read-only room offers no quote", async () => {
	await page.render(<Message quotable={false} />);
	await rightClick(q("li.message"));
	expect(labels()).not.toContain("Quote reply");
});

test("Select text selects the message's words, and Share hands them to the system share sheet", async () => {
	const shared: unknown[] = [];
	Object.defineProperty(navigator, "share", {
		value: (data: unknown) => {
			shared.push(data);
			return Promise.resolve();
		},
		configurable: true,
	});
	await page.render(<Message />);
	await rightClick(q("li.message"));
	await choose("Select text");
	expect(window.getSelection()?.toString()).toContain("hello");
	await rightClick(q("li.message"));
	await choose("Share");
	expect(shared.length).toBe(1);
	expect((shared[0] as { text: string }).text).toContain("hello bold");
});

test("system lines have no menu", async () => {
	await page.render(
		<Message
			message={said({ kind: "system", text: "Conversation started over" })}
		/>,
	);
	await rightClick(q("li.line"));
	expect(labels()).toEqual([]);
});

test("a message's avatar opens the agent sheet; the message's own menu does not also open", async () => {
	await page.render(<Message />);
	await rightClick(q(".message-avatar"));
	expect(labels()).toEqual(["Knight profile"]);
	await choose("Knight profile");
	expect(currentAgentSheet()).toMatchObject({ name: "scout", look: false });
});

// ── Cards and files ──────────────────────────────────────────────────────────────────────────

const approval: PromptFrame = {
	id: "p1",
	kind: "approval",
	title: "Run the deploy?",
	message: "Deploy **web** to staging",
	purpose: "action",
	approval: {
		tool: "bash",
		action: "deploy staging",
		input: { command: "make deploy" },
		files: [{ path: "deploy.sh", bytes: 12 }],
	},
};

test("a card's menu copies its details: title, text, tool, action and input", async () => {
	const written = copied();
	await page.render(
		<ConfigContext.Provider value={config}>
			<PromptCard
				card={{ room: SCOUT, frame: approval, after: 0 }}
				timeZone="UTC"
			/>
			<ActionMenuHost />
		</ConfigContext.Provider>,
	);
	await rightClick(q("article.prompt"));
	expect(labels()).toEqual(["Copy details"]);
	await choose("Copy details");
	const text = written[0] ?? "";
	expect(text).toContain("Run the deploy?");
	expect(text).toContain("Deploy **web** to staging");
	expect(text).toContain("bash");
	expect(text).toContain("deploy staging");
	expect(text).toContain("make deploy");
	expect(text).toContain("deploy.sh");
});

const doc: RoomFile = {
	id: "f1",
	name: "report.pdf",
	type: "application/pdf",
	size: 120,
} as RoomFile;
const picture: RoomFile = {
	id: "f2",
	name: "chart.png",
	type: "image/png",
	size: 90,
} as RoomFile;

test("a file chip's menu downloads the file, and shares it when the browser can", async () => {
	const clicks: HTMLAnchorElement[] = [];
	const onClick = (event: Event) => {
		if (event.target instanceof HTMLAnchorElement && event.target.download)
			clicks.push(event.target);
	};
	document.addEventListener("click", onClick, true);
	try {
		await page.render(<Message message={said({ files: [doc, picture] })} />);
		await rightClick(q(".file-chip"));
		expect(labels()).toEqual(["Download"]);
		expect(q(".file-chip")?.getAttribute("data-hold")).toBe("row");
		await choose("Download");
		expect(clicks.length).toBe(1);
		expect(clicks[0]?.download).toBe("report.pdf");
		expect(clicks[0]?.getAttribute("href")).toBe("api/files/f1");

		const shared: unknown[] = [];
		Object.defineProperty(navigator, "share", {
			value: (data: unknown) => {
				shared.push(data);
				return Promise.resolve();
			},
			configurable: true,
		});
		await rightClick(q(".file-chip"));
		expect(labels()).toEqual(["Download", "Share"]);
		await choose("Share");
		expect(shared).toEqual([
			{ title: "report.pdf", url: new URL("api/files/f1", location.href).href },
		]);

		// A picture is a file too; the message's own menu is not what opens over it.
		await rightClick(q("img.file-image"));
		expect(labels()).toEqual(["Download", "Share"]);
	} finally {
		document.removeEventListener("click", onClick, true);
	}
});
