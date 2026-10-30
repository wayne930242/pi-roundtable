import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { partial } from "pi-roundtable/testing";
import type { ConfigView, RoomMessage, RoomView } from "../src/api-types.ts";
import { openPage, releaseDom, type TestPage } from "./dom.ts";
import { api } from "./lib/api.ts";
import { store } from "./lib/app-store.ts";
import { ConfigContext } from "./lib/config.ts";
import { setRouting } from "./lib/router.ts";
import { type AppConnection, setConnection } from "./lib/socket.ts";
import { RoomPage } from "./pages/room.tsx";

const GUIDE = "app:agent.guide";
const SCOUT = "app:agent.scout";
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

const message = (id: number, over: Partial<RoomMessage> = {}): RoomMessage => ({
	id,
	room: GUIDE,
	kind: "owner",
	principalId: "bob",
	author: "Bob",
	text: `message ${id}`,
	files: [],
	at: "2026-10-30T10:00:00.000Z",
	...over,
});

const said: unknown[][] = [];
let page: TestPage;
beforeAll(async () => {
	page = await openPage();
	setRouting(undefined);
	setConnection(
		partial<AppConnection>({
			send: () => true,
			focus: () => undefined,
			say: (...args: unknown[]) => {
				said.push(args);
			},
		}),
	);
});
afterAll(async () => {
	setConnection(undefined);
	await page.unmount();
	await releaseDom();
});
afterEach(() => {
	said.length = 0;
});

const settle = (ms = 60) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));
const q = <T extends Element = HTMLElement>(selector: string): T | null =>
	page.container.querySelector<T>(selector);

async function open(room: RoomView, messages: RoomMessage[] = []) {
	const history = spyOn(api, "messages").mockResolvedValue({
		messages,
		more: false,
		cards: [],
	});
	store.dispatch({ type: "rooms_loaded", rooms: [room] });
	store.dispatch({
		type: "ready",
		protocol: 1,
		principal: "ada",
		name: "Ada",
		uploads: { perMessage: 4, maxBytes: 1000 },
	} as never);
	await page.render(
		<ConfigContext.Provider value={config}>
			<RoomPage roomKey={room.key} />
		</ConfigContext.Provider>,
	);
	await page.act(() => settle());
	return history;
}

async function write(text: string) {
	const box = q<HTMLTextAreaElement>("textarea");
	if (!box) throw new Error("no box");
	await page.act(() => {
		const set = Object.getOwnPropertyDescriptor(
			HTMLTextAreaElement.prototype,
			"value",
		)?.set;
		set?.call(box, text);
		box.dispatchEvent(new Event("input", { bubbles: true }));
	});
	await page.click(q("button.composer-send"));
	await page.act(() => settle());
}

test("a room only one person reads has no switch and sends as it always did", async () => {
	const history = await open(view(GUIDE));
	try {
		expect(q("button.mode-toggle")).toBeNull();
		expect(q("textarea")?.getAttribute("placeholder")).toBe("Message guide");
		await write("hello");
		expect(said).toEqual([[GUIDE, "hello", [], undefined]]);
	} finally {
		history.mockRestore();
	}
});

test("a room more than one person reads offers @AI, on by default; off it writes a note", async () => {
	const history = await open(view(GUIDE, { notes: true }));
	try {
		const toggle = q<HTMLButtonElement>("button.mode-toggle");
		expect(toggle?.textContent).toBe("@AI");
		expect(toggle?.getAttribute("aria-checked")).toBe("true");
		expect(q("textarea")?.getAttribute("placeholder")).toBe("Ask AI…");
		await write("ask the agent");
		expect(said.at(-1)).toEqual([GUIDE, "ask the agent", [], undefined]);

		await page.click(toggle);
		expect(q("button.mode-toggle")?.getAttribute("aria-checked")).toBe("false");
		expect(q("textarea")?.getAttribute("placeholder")).toBe(
			"Write an internal note…",
		);
		await write("for the others");
		expect(said.at(-1)).toEqual([GUIDE, "for the others", [], "note"]);
	} finally {
		history.mockRestore();
	}
});

async function type(text: string) {
	const box = q<HTMLTextAreaElement>("textarea");
	if (!box) throw new Error("no box");
	await page.act(() => {
		const set = Object.getOwnPropertyDescriptor(
			HTMLTextAreaElement.prototype,
			"value",
		)?.set;
		set?.call(box, text);
		box.dispatchEvent(new Event("input", { bubbles: true }));
	});
	await page.act(() => settle());
}

/** A paste: the paste event, then the text landing in the box. */
async function paste(text: string) {
	const box = q<HTMLTextAreaElement>("textarea");
	if (!box) throw new Error("no box");
	await page.act(() => {
		const event = new Event("paste", { bubbles: true, cancelable: true });
		Object.defineProperty(event, "clipboardData", {
			value: { files: [], getData: () => text },
		});
		box.dispatchEvent(event);
	});
	await type(text);
}

test("typing @AI at the start with the switch off turns it on and sends a turn without the token; @AI elsewhere, in a paste, or in an address leaves the note", async () => {
	const history = await open(view(GUIDE, { notes: true }));
	try {
		const toggle = () => q<HTMLButtonElement>("button.mode-toggle");
		const on = () => toggle()?.getAttribute("aria-checked") === "true";
		const send = async () => {
			await page.click(q("button.composer-send"));
			await page.act(() => settle());
		};
		// The page keeps the last room's setting between tests; start from the switch off.
		if (on()) await page.click(toggle());
		expect(on()).toBe(false);

		await type("@AI, what do you think?");
		expect(on()).toBe(true);
		expect(toggle()?.disabled).toBe(true);
		expect(q("textarea")?.getAttribute("placeholder")).toBe("Ask AI…");
		await type("what do you think?");
		expect(on()).toBe(false);
		expect(toggle()?.disabled).toBe(false);
		await type("@AI, what do you think?");
		await send();
		expect(on()).toBe(false);

		for (const text of [
			"so, @AI",
			"mail a@ai.com for the team",
			"@AIX is a name",
		]) {
			await type(text);
			expect(on()).toBe(false);
			await send();
		}
		await paste("@AI forwarded from a customer");
		expect(on()).toBe(false);
		await send();

		expect(said).toEqual([
			[GUIDE, "what do you think?", [], "turn"],
			[GUIDE, "so, @AI", [], "note"],
			[GUIDE, "mail a@ai.com for the team", [], "note"],
			[GUIDE, "@AIX is a name", [], "note"],
			[GUIDE, "@AI forwarded from a customer", [], "note"],
		]);
	} finally {
		history.mockRestore();
	}
});

test("a room only one person reads takes @AI as plain text", async () => {
	const history = await open(view(SCOUT));
	try {
		await type("@AI is only text here");
		await page.click(q("button.composer-send"));
		await page.act(() => settle());
		expect(said).toEqual([[SCOUT, "@AI is only text here", [], undefined]]);
	} finally {
		history.mockRestore();
	}
});

test("another room opens with @AI on again", async () => {
	const history = await open(view(SCOUT, { notes: true }));
	try {
		expect(q("button.mode-toggle")?.getAttribute("aria-checked")).toBe("true");
	} finally {
		history.mockRestore();
	}
});

test("a note stands apart: its author's name and picture, the marker, and no agent bubble", async () => {
	const history = await open(view(GUIDE, { notes: true }), [
		message(1, {
			kind: "owner",
			text: "ask something",
			principalId: "ada",
			author: "Ada",
		}),
		message(2, { text: "**for Ada** only", note: true }),
		message(3, {
			text: "my own reminder",
			note: true,
			principalId: "ada",
			author: "Ada",
		}),
	]);
	try {
		await page.act(() => settle(120));
		const notes = [
			...page.container.querySelectorAll<HTMLElement>("li[data-note]"),
		];
		expect(notes).toHaveLength(2);
		const [theirs, mine] = notes;
		expect(theirs?.textContent).toContain("Bob");
		expect(theirs?.textContent).toContain("Internal note");
		expect(theirs?.querySelector(".bubble strong")?.textContent).toBe(
			"for Ada",
		);
		expect(theirs?.querySelector("img")?.getAttribute("src")).toBe(
			"api/people/bob/picture",
		);
		expect(theirs?.hasAttribute("data-mine")).toBe(false);
		expect(mine?.hasAttribute("data-mine")).toBe(true);
		// An ordinary message of the room carries no marker.
		const ordinary = q('li.message[data-mid="1"]');
		expect(ordinary?.hasAttribute("data-note")).toBe(false);
		expect(ordinary?.textContent).not.toContain("Internal note");
	} finally {
		history.mockRestore();
	}
});
