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
import { QueuedEditHost } from "./components/queued-edit.tsx";
import { RoomConfirmHost } from "./components/room-confirms.tsx";
import { RoomMenu } from "./components/room-menu.tsx";
import { SelectTextSheetHost } from "./components/select-text-sheet.tsx";
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
import { closeSelectText } from "./lib/message-sheets.ts";
import { loadBuiltInMessages, setPresentation } from "./lib/messages.ts";
import { clearQueuedEdit } from "./lib/queued-edit.ts";
import { setRouting } from "./lib/router.ts";
import { startShortcuts } from "./lib/shortcuts.ts";
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
/** Waits for the page to show the element: a part that loads on demand shows a moment after its render, however busy the machine is. */
const shown = async (selector: string): Promise<Element | null> => {
	const stop = Date.now() + 3000;
	while (!document.querySelector(selector) && Date.now() < stop)
		await page.act(async () => {
			await settle(20);
		});
	return document.querySelector(selector);
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
		"Skills",
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

test("Edit knight opens the knight sheet; Change look opens it at the character creator; Skills at the skills", async () => {
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

	closeAgentSheet();
	await rightClick(rowOf("scout"));
	await choose("Skills");
	expect(currentAgentSheet()).toMatchObject({
		name: "scout",
		look: false,
		skills: true,
	});
	expect(window.location.hash).toBe("#/rooms");
});

test("the room menu's Skills closes the menu and opens the knight sheet at the skills; a group's menu has none", async () => {
	let closed = 0;
	const menu = (agent?: string) => (
		<ConfigContext.Provider value={config}>
			<RoomMenu
				open
				room={SCOUT}
				mode={{ yolo: false, longRunning: false }}
				agent={agent}
				onClose={() => {
					closed += 1;
				}}
				onAskYolo={() => undefined}
				onAskStartOver={() => undefined}
			/>
		</ConfigContext.Provider>
	);
	const skillsItem = () =>
		[...document.querySelectorAll<HTMLButtonElement>(".menu-link")].find(
			(one) => one.querySelector("strong")?.textContent === "Skills",
		) ?? null;
	await page.render(menu("scout"));
	await page.click(skillsItem());
	expect(closed).toBe(1);
	expect(currentAgentSheet()).toMatchObject({ name: "scout", skills: true });
	closeAgentSheet();
	await page.render(menu());
	expect(skillsItem()).toBeNull();
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

test("on a phone Select text opens the message's text alone in a sheet, where nothing else can be selected and Copy all copies it", async () => {
	window.innerWidth = 390;
	const copied: string[] = [];
	Object.defineProperty(navigator, "clipboard", {
		configurable: true,
		value: { writeText: async (text: string) => void copied.push(text) },
	});
	await page.render(
		<>
			<Message />
			<SelectTextSheetHost />
		</>,
	);
	await rightClick(q("li.message"));
	await choose("Select text");
	await page.act(async () => void (await settle(300)));
	const text = document.querySelector<HTMLElement>("pre.select-text");
	const sheet = text?.closest("dialog");
	expect(sheet?.open).toBe(true);
	// Exactly what was written, as stored: the Markdown marks and the line break too.
	expect(text?.textContent).toBe("hello **bold**\nsecond line");
	expect(sheet?.querySelector("[data-hold]")).toBeNull();
	expect(text?.closest("[data-hold]")).toBeNull();
	expect(window.getSelection()?.toString() ?? "").toBe("");
	await page.click(
		[...(sheet?.querySelectorAll("button") ?? [])].find(
			(one) => one.textContent === "Copy all",
		) ?? null,
	);
	await page.act(async () => void (await settle()));
	expect(copied).toEqual(["hello **bold**\nsecond line"]);
	await page.act(() => closeSelectText());
	await page.act(async () => void (await settle(300)));
	Reflect.deleteProperty(navigator, "clipboard");
});

test("Share hands the message's words to the system share sheet", async () => {
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
		// The attachments load on demand.
		await rightClick(await shown(".file-chip"));
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
		await rightClick(await shown("img.file-image"));
		expect(labels()).toEqual(["Download", "Share"]);
	} finally {
		document.removeEventListener("click", onClick, true);
	}
});

/** An owner message of Ada's, sent while a turn ran. */
const sentDuring = (
	delivery: NonNullable<RoomMessage["delivery"]>,
	over: Partial<RoomMessage> = {},
): RoomMessage => ({
	id: 21,
	room: SCOUT,
	kind: "owner",
	principalId: "ada",
	author: "Ada",
	text: "one more thing",
	files: [],
	at: "2026-10-28T10:00:00.000Z",
	delivery,
	...over,
});

const signedInAsAda = () =>
	store.dispatch({
		type: "ready",
		protocol: 1,
		principal: "ada",
		name: "Ada",
		uploads: { perMessage: 4, maxBytes: 1000 },
	} as never);

/** Replaces the page's connection with one that keeps what it is told to send. */
function listening(): object[] {
	const sent: object[] = [];
	setConnection(
		partial<AppConnection>({
			send: (frame: object) => {
				sent.push(frame);
				return true;
			},
		}),
	);
	return sent;
}

test("a message sent during a turn says where it stands: added to the turn, queued, or cancelled", async () => {
	for (const [delivery, line] of [
		["steered", "Added to this turn"],
		["queued", "Queued"],
		["cancelled", "Cancelled"],
	] as const) {
		await page.render(<Message message={sentDuring(delivery)} />);
		await page.act(async () => {
			await settle(120);
		});
		expect(q(".delivery-line")?.textContent).toBe(line);
		expect(q("li.message")?.getAttribute("data-delivery")).toBe(delivery);
	}
	await page.render(<Message message={sentDuring("queued")} />);
	await page.render(<Message message={said()} />);
	expect(q(".delivery-line")).toBeNull();
});

test("a queued message offers its author Edit and Cancel; Cancel sends the frame", async () => {
	signedInAsAda();
	const sent = listening();
	await page.render(<Message message={sentDuring("queued")} />);
	await settle(120);
	await rightClick(q("li.message"));
	expect(labels().slice(0, 3)).toEqual(["Edit", "Cancel", "Copy"]);
	await choose("Cancel");
	expect(sent).toEqual([{ type: "cancel_queued", room: SCOUT, message: 21 }]);
	setConnection(partial<AppConnection>({ send: () => true }));
});

test("Edit opens the text in a sheet and Save sends the new text", async () => {
	signedInAsAda();
	const sent = listening();
	await page.render(
		<>
			<Message message={sentDuring("queued")} />
			<QueuedEditHost />
		</>,
	);
	await settle(120);
	await rightClick(q("li.message"));
	await choose("Edit");
	const box = q<HTMLTextAreaElement>("textarea.queued-edit-text");
	expect(box?.value).toBe("one more thing");
	await page.act(() => {
		if (box) {
			Object.getOwnPropertyDescriptor(
				HTMLTextAreaElement.prototype,
				"value",
			)?.set?.call(box, "one more thing, please");
			box.dispatchEvent(new Event("input", { bubbles: true }));
		}
	});
	const save = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
		(one) => one.textContent === "Save",
	);
	if (!save) throw new Error("no Save button");
	await page.click(save);
	await settle(40);
	expect(sent).toEqual([
		{
			type: "edit_queued",
			room: SCOUT,
			message: 21,
			text: "one more thing, please",
		},
	]);
	setConnection(partial<AppConnection>({ send: () => true }));
});

test("a steered, a cancelled, or another person's queued message offers neither Edit nor Cancel", async () => {
	signedInAsAda();
	for (const message of [
		sentDuring("steered"),
		sentDuring("cancelled"),
		sentDuring("queued", { principalId: "bob", author: "Bob" }),
	]) {
		await page.render(<Message message={message} />);
		await settle(120);
		await rightClick(q("li.message"));
		expect(labels()).not.toContain("Edit");
		expect(labels()).not.toContain("Cancel");
		await page.act(() => closeMenu());
	}
});

/** Puts messages in the store as the room's stored ones and opens the room. */
function holdMessages(room: string, ...messages: RoomMessage[]): void {
	store.dispatch({
		type: "history_loaded",
		room,
		messages: messages.map((message) => ({ ...message, room })),
		more: false,
		older: false,
	});
	window.location.hash = `#/room/${encodeURIComponent(room)}`;
}

const arrowUp = (target: Element, init: KeyboardEventInit = {}) => {
	const event = new KeyboardEvent("keydown", {
		key: "ArrowUp",
		bubbles: true,
		cancelable: true,
		...init,
	});
	target.dispatchEvent(event);
	return event;
};

const composerBox = () => q<HTMLTextAreaElement>(".composer textarea");

test("↑ in the empty message box edits the person's latest queued message", async () => {
	signedInAsAda();
	holdMessages(
		SCOUT,
		sentDuring("queued", { id: 21, text: "first" }),
		sentDuring("queued", { id: 22, text: "second" }),
		sentDuring("queued", { id: 23, text: "bob's", principalId: "bob" }),
		said({ id: 24 }),
	);
	const stop = startShortcuts();
	try {
		await page.render(
			<>
				<Message composer />
				<QueuedEditHost />
			</>,
		);
		const box = composerBox();
		if (!box) throw new Error("no message box");
		let event: KeyboardEvent | undefined;
		await page.act(() => {
			event = arrowUp(box);
		});
		expect(event?.defaultPrevented).toBe(true);
		await settle(40);
		expect(q<HTMLTextAreaElement>("textarea.queued-edit-text")?.value).toBe(
			"second",
		);
	} finally {
		stop();
		await page.act(() => clearQueuedEdit());
	}
});

test("↑ does nothing with text in the box, with a modifier, while an input method composes, or without a queued message of one's own", async () => {
	signedInAsAda();
	const stop = startShortcuts();
	try {
		holdMessages(
			TEAM,
			sentDuring("steered"),
			sentDuring("queued", { id: 22, principalId: "bob" }),
			sentDuring("cancelled", { id: 23 }),
		);
		await page.render(
			<>
				<Message composer />
				<QueuedEditHost />
			</>,
		);
		const box = composerBox();
		if (!box) throw new Error("no message box");
		expect(arrowUp(box).defaultPrevented).toBe(false);
		await settle(40);
		expect(q("textarea.queued-edit-text")).toBeNull();

		holdMessages(WORK, sentDuring("queued"));
		const idle = async (event: KeyboardEvent) => {
			expect(event.defaultPrevented).toBe(false);
			await settle(40);
			expect(q("textarea.queued-edit-text")).toBeNull();
		};
		await idle(arrowUp(box, { isComposing: true }));
		await idle(arrowUp(box, { keyCode: 229 }));
		await idle(arrowUp(box, { shiftKey: true }));
		await idle(arrowUp(box, { ctrlKey: true }));
		await idle(arrowUp(box, { repeat: true }));
		// Alt+↑ still goes to the room before this one.
		expect(arrowUp(box, { altKey: true }).defaultPrevented).toBe(true);
		await settle(40);
		expect(q("textarea.queued-edit-text")).toBeNull();

		// The same key in the same box does act when nothing above stands in its way.
		holdMessages(WORK, sentDuring("queued"));
		expect(arrowUp(box).defaultPrevented).toBe(true);
		await page.act(() => clearQueuedEdit());
		await page.act(() => {
			box.value = "typing";
			box.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await idle(arrowUp(box));
		await idle(arrowUp(document.body));
	} finally {
		stop();
		await page.act(() => clearQueuedEdit());
	}
});

test("the shortcut list names ↑ for editing a waiting message, in en and zh-TW", async () => {
	const { default: ShortcutHelp } = await import(
		"./components/shortcut-help.tsx"
	);
	await page.render(<ShortcutHelp open />);
	expect(document.querySelector(".shortcut-list")?.textContent).toContain(
		"Edit your latest message that is still waiting",
	);
	await loadBuiltInMessages("zh-TW");
	setPresentation({
		title: "Console",
		panes: [],
		timeZone: "UTC",
		locale: "zh-TW",
	});
	try {
		await page.render(<ShortcutHelp open />);
		expect(document.querySelector(".shortcut-list")?.textContent).toContain(
			"\u7de8\u8f2f\u4f60\u6700\u65b0\u4e00\u5247\u9084\u5728\u6392\u968a\u7684\u8a0a\u606f",
		);
	} finally {
		setPresentation({ title: "Console", panes: [], timeZone: "UTC" });
		await loadBuiltInMessages(undefined);
	}
});
