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
import type { ConfigView, RoomView } from "../src/api-types.ts";
import { CouncilView } from "./components/council-view.tsx";
import { openPage, releaseDom, type TestPage } from "./dom.ts";
import { api } from "./lib/api.ts";
import { store } from "./lib/app-store.ts";
import { ConfigContext } from "./lib/config.ts";
import { resetCouncilChoice } from "./lib/council.ts";
import { resetCouncilModes, setCouncilMode } from "./lib/council-mode.ts";
import { loadKit } from "./lib/kit.ts";
import { setLook } from "./lib/look.ts";
import { setRouting } from "./lib/router.ts";
import { type AppConnection, setConnection } from "./lib/socket.ts";

const config: ConfigView = {
	title: "Console",
	panes: ["rooms", "table"],
	timeZone: "UTC",
	look: "modern",
};

const agent = (name: string, displayName: string): RoomView => ({
	key: `app:agent.${name}`,
	kind: "agent",
	name,
	displayName,
	home: false,
	readOnly: false,
	mode: { yolo: false, longRunning: false },
	typing: false,
	stoppable: false,
});

let page: TestPage;
let messages: ReturnType<typeof spyOn>;
const said: string[] = [];

beforeAll(async () => {
	await loadKit();
	await import("./components/council-view.tsx");
	await import("./components/mention-menu.tsx");
	page = await openPage();
	setRouting(undefined);
});
afterAll(async () => {
	setConnection(undefined);
	await page.unmount();
	await releaseDom();
});
beforeEach(() => {
	said.length = 0;
	window.localStorage.clear();
	setLook("modern");
	resetCouncilModes();
	resetCouncilChoice();
	setConnection(
		partial<AppConnection>({
			send: () => true,
			focus: () => undefined,
			say: (_room: string, text: string) => {
				said.push(text);
				return true;
			},
		}),
	);
	messages = spyOn(api, "messages").mockResolvedValue({
		messages: [],
		more: false,
		cards: [],
	});
});
afterEach(async () => {
	messages.mockRestore();
	await page.render(null);
	store.dispatch({ type: "rooms_loaded", rooms: [] });
	window.localStorage.clear();
	resetCouncilModes();
	setLook(undefined);
});

const settle = (ms = 80) =>
	page.act(() => new Promise((done) => setTimeout(done, ms)));
const q = <T extends Element>(selector: string): T | null =>
	document.querySelector<T>(selector);
const all = <T extends Element>(selector: string): T[] => [
	...document.querySelectorAll<T>(selector),
];

/** A council of three knights in a room of its own, in the chat or in the animated scene. */
async function council(key: string, mode: "chat" | "scene") {
	const room: RoomView = {
		key: `app:group.${key}`,
		kind: "group",
		name: key,
		displayName: key,
		home: false,
		readOnly: false,
		members: ["guide", "scout", "aide"],
		mode: { yolo: false, longRunning: false },
		typing: false,
		stoppable: false,
	};
	store.dispatch({
		type: "rooms_loaded",
		rooms: [
			agent("guide", "Guide"),
			agent("scout", "Blog Editor"),
			agent("aide", "Aide Two"),
			room,
		],
	});
	setCouncilMode(room.key, mode);
	await page.render(
		<ConfigContext.Provider value={config}>
			<CouncilView roomKey={room.key} />
		</ConfigContext.Provider>,
	);
	await settle();
	const box = () => q<HTMLTextAreaElement>("textarea");
	const type = async (text: string, caret = text.length) => {
		const field = box();
		if (!field) throw new Error("no composer");
		await page.act(() => {
			field.focus();
			Object.getOwnPropertyDescriptor(
				HTMLTextAreaElement.prototype,
				"value",
			)?.set?.call(field, text);
			field.dispatchEvent(new Event("input", { bubbles: true }));
			field.setSelectionRange(caret, caret);
		});
		await settle(40);
	};
	const press = async (key: string, init: KeyboardEventInit = {}) => {
		const event = new KeyboardEvent("keydown", {
			key,
			bubbles: true,
			cancelable: true,
			...init,
		});
		await page.act(() => {
			box()?.dispatchEvent(event);
		});
		await settle(30);
		return event;
	};
	const options = () =>
		all<HTMLElement>(".mention-menu [role=option]").map((o) => o.textContent);
	return { room, box, type, press, options };
}

test("a tap on a knight in the animated scene mentions it in the room's box and does not navigate", async () => {
	window.location.hash = "#/table/scene-a";
	const { box } = await council("scene-a", "scene");
	const seat = q<SVGGElement>('.room-scene g.seat[data-seat="scout"]');
	expect(seat).not.toBeNull();
	await page.act(() => {
		seat?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	});
	await settle(30);
	expect(box()?.value).toBe("@Blog Editor ");
	expect(box()?.selectionStart).toBe("@Blog Editor ".length);
	expect(document.activeElement).toBe(box() ?? null);
	expect(window.location.hash).toBe("#/table/scene-a");
	// A second tap goes after the first.
	await page.act(() => {
		q('.room-scene g.seat[data-seat="guide"]')?.dispatchEvent(
			new MouseEvent("click", { bubbles: true }),
		);
	});
	await settle(30);
	expect(box()?.value).toBe("@Blog Editor @Guide ");
});

test("an @ at a word start opens the member list over the box, filtered as the name is typed", async () => {
	const { type, options } = await council("auto-a", "chat");
	await type("hello");
	expect(options()).toEqual([]);
	await type("hello @");
	expect(options()).toEqual(["Guide", "Blog Editor", "Aide Two"]);
	await type("hello @ed");
	expect(options()).toEqual(["Blog Editor"]);
	// An @ inside a word, and a name nobody has, open nothing.
	await type("mail me@ed");
	expect(options()).toEqual([]);
	await type("@zzz");
	expect(options()).toEqual([]);
});

test("arrows move, Enter picks without sending, and the display name goes in with a space", async () => {
	const { type, press, box, options } = await council("auto-b", "chat");
	await type("hi @");
	expect(
		all<HTMLElement>(".mention-menu [role=option]").map((o) =>
			o.getAttribute("aria-selected"),
		),
	).toEqual(["true", "false", "false"]);
	await press("ArrowDown");
	await press("ArrowDown");
	await press("ArrowUp");
	const chosen = all<HTMLElement>(".mention-menu [role=option]").findIndex(
		(o) => o.getAttribute("aria-selected") === "true",
	);
	expect(chosen).toBe(1);
	const enter = await press("Enter");
	expect(enter.defaultPrevented).toBe(true);
	expect(box()?.value).toBe("hi @Blog Editor ");
	expect(box()?.selectionStart).toBe("hi @Blog Editor ".length);
	expect(said).toEqual([]);
	expect(options()).toEqual([]);
});

test("Tab picks the first match; Escape closes the list and leaves the text", async () => {
	const { type, press, box, options } = await council("auto-c", "chat");
	await type("@a");
	expect(options()).toEqual(["Aide Two"]);
	await press("Escape");
	expect(options()).toEqual([]);
	expect(box()?.value).toBe("@a");
	await type("@ai");
	await press("Tab");
	// "@ai" at the start is the room's own shorthand: no list, so Tab did nothing.
	expect(box()?.value).toBe("@ai");
	await type("x @a");
	await press("Tab");
	expect(box()?.value).toBe("x @Aide Two ");
});

test("a tap on an entry picks it; the box keeps the focus", async () => {
	const { type, box } = await council("auto-d", "chat");
	await type("ask @gu");
	const entry = all<HTMLElement>(".mention-menu [role=option]")[0];
	const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
	await page.act(() => {
		entry?.dispatchEvent(down);
	});
	expect(down.defaultPrevented).toBe(true);
	await page.click(entry ?? null);
	await settle(30);
	expect(box()?.value).toBe("ask @Guide ");
	expect(document.activeElement).toBe(box() ?? null);
});

test("nothing acts during an input method's composition, and Enter still sends when no list is open", async () => {
	const { type, press, box, options } = await council("auto-e", "chat");
	await type("@gu");
	await press("Enter", { isComposing: true });
	await press("ArrowDown", { isComposing: true });
	expect(box()?.value).toBe("@gu");
	expect(options()).toEqual(["Guide"]);
	expect(said).toEqual([]);
	// The leading @AI toggle is not touched: it sends as typed.
	await type("@AI hello");
	expect(options()).toEqual([]);
	await press("Enter");
	await settle(30);
	expect(said).toEqual(["@AI hello"]);
});
