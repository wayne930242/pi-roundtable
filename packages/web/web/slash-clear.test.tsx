import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { partial } from "pi-roundtable/testing";
import type { ConfigView, RoomView } from "../src/api-types.ts";
import { Composer } from "./components/composer.tsx";
import { RoomConfirmHost } from "./components/room-confirms.tsx";
import { Toaster } from "./components/toaster.tsx";
import { openPage, releaseDom, type TestPage } from "./dom.ts";
import { api } from "./lib/api.ts";
import { store } from "./lib/app-store.ts";
import { ConfigContext } from "./lib/config.ts";
import { hostRoomCommands } from "./lib/room-commands.ts";
import { setRouting } from "./lib/router.ts";
import type { SlashCommand } from "./lib/slash-commands.ts";
import { type AppConnection, setConnection } from "./lib/socket.ts";
import { RoomPage } from "./pages/room.tsx";

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
	displayName: "Clearable",
	home: false,
	readOnly: false,
	mode: { yolo: false, longRunning: false },
	typing: false,
	stoppable: false,
	...over,
});

let page: TestPage;
const said: string[] = [];
beforeAll(async () => {
	page = await openPage();
	setRouting(undefined);
	setConnection(
		partial<AppConnection>({
			send: () => true,
			focus: () => undefined,
			say: (_room: string, text: string) => {
				said.push(text);
			},
		}),
	);
});
afterAll(async () => {
	setConnection(undefined);
	await page.unmount();
	await releaseDom();
});

const settle = (ms = 60) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));
const area = () =>
	page.container.querySelector<HTMLTextAreaElement>(".composer textarea");
const menu = () => page.container.querySelector(".command-menu");
const type = (text: string) =>
	page.act(async () => {
		const element = area();
		if (!element) throw new Error("no message box");
		Object.getOwnPropertyDescriptor(
			HTMLTextAreaElement.prototype,
			"value",
		)?.set?.call(element, text);
		element.dispatchEvent(new Event("input", { bubbles: true }));
		await settle();
	});
const press = (key: string, init: KeyboardEventInit = {}) => {
	const event = new KeyboardEvent("keydown", {
		key,
		bubbles: true,
		cancelable: true,
		...init,
	});
	return page
		.act(() => {
			area()?.dispatchEvent(event);
		})
		.then(() => event);
};

function box(commands: SlashCommand[], draftKey: string, sent: string[]) {
	return (
		<Composer
			draftKey={draftKey}
			name="Room"
			limits={undefined}
			stoppable={false}
			commands={commands}
			onSend={(text) => sent.push(text)}
			onStop={() => undefined}
		/>
	);
}
const command = (ran: string[], over: Partial<SlashCommand> = {}) => ({
	name: "clear",
	aliases: ["new"],
	description: "Start over",
	run: () => {
		ran.push("clear");
	},
	...over,
});

test("a slash at the start of the box opens the menu; picking a command runs it and sends nothing", async () => {
	const ran: string[] = [];
	const sent: string[] = [];
	await page.render(box([command(ran)], "app:agent.menu-run", sent));
	expect(menu()).toBeNull();
	await type("hello");
	expect(menu()).toBeNull();
	await type("/");
	await page.act(() => settle(80));
	expect(menu()?.getAttribute("role")).toBe("listbox");
	const item = menu()?.querySelector<HTMLElement>("[role=option]");
	expect(item?.textContent).toContain("/clear");
	expect(item?.textContent).toContain("Start over");
	expect(item?.getAttribute("aria-selected")).toBe("true");
	expect(area()?.getAttribute("aria-activedescendant")).toBe(item?.id);
	// A tap picks it without taking the focus from the box.
	const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
	item?.dispatchEvent(down);
	expect(down.defaultPrevented).toBe(true);
	await page.click(item ?? null);
	expect(ran).toEqual(["clear"]);
	expect(sent).toEqual([]);
	expect(area()?.value).toBe("");
	expect(menu()).toBeNull();
});

test("Enter runs the choice, Tab writes its name, Esc closes the menu until the text changes", async () => {
	const ran: string[] = [];
	const sent: string[] = [];
	await page.render(
		box(
			[
				command(ran),
				command(ran, {
					name: "clip",
					aliases: [],
					description: "Another",
					run: () => {
						ran.push("clip");
					},
				}),
			],
			"app:agent.menu-keys",
			sent,
		),
	);
	await type("/c");
	expect(menu()?.querySelectorAll("[role=option]")).toHaveLength(2);
	await press("ArrowDown");
	expect(
		menu()?.querySelectorAll("[role=option]")[1]?.getAttribute("aria-selected"),
	).toBe("true");
	await press("ArrowUp");
	await press("ArrowUp");
	expect(
		menu()?.querySelectorAll("[role=option]")[1]?.getAttribute("aria-selected"),
	).toBe("true");
	const tab = await press("Tab");
	expect(tab.defaultPrevented).toBe(true);
	expect(area()?.value).toBe("/clip");
	await type("/cl");
	const enter = await press("Enter");
	expect(enter.defaultPrevented).toBe(true);
	expect(ran).toEqual(["clear"]);
	expect(sent).toEqual([]);
	// Esc closes the menu and is taken, so nothing else leaves the box.
	await type("/c");
	const esc = await press("Escape");
	expect(esc.defaultPrevented).toBe(true);
	expect(menu()).toBeNull();
	await type("/cl");
	expect(menu()).not.toBeNull();
});

test("nothing acts while an input method composes", async () => {
	const ran: string[] = [];
	const sent: string[] = [];
	await page.render(box([command(ran)], "app:agent.menu-ime", sent));
	await type("/");
	const arrows = await press("ArrowDown", { cancelable: true });
	const composing = await press("Enter", { isComposing: true });
	const safari = new KeyboardEvent("keydown", {
		key: "Enter",
		bubbles: true,
		cancelable: true,
	});
	Object.defineProperty(safari, "keyCode", { value: 229 });
	await page.act(() => {
		area()?.dispatchEvent(safari);
	});
	expect(arrows.defaultPrevented).toBe(true);
	expect(composing.defaultPrevented).toBe(false);
	expect(safari.defaultPrevented).toBe(false);
	expect(ran).toEqual([]);
	expect(sent).toEqual([]);
});

test("/clear and /new typed whole run the command, trimmed and in any case, and send nothing", async () => {
	for (const typed of ["/clear", "  /CLEAR ", "/new"]) {
		const ran: string[] = [];
		const sent: string[] = [];
		await page.render(null);
		await page.render(
			box([command(ran)], `app:agent.typed-${typed.trim()}`, sent),
		);
		await type(typed);
		const form = page.container.querySelector("form");
		await page.act(() => {
			form?.dispatchEvent(
				new Event("submit", { bubbles: true, cancelable: true }),
			);
		});
		expect(ran).toEqual(["clear"]);
		expect(sent).toEqual([]);
		expect(area()?.value).toBe("");
	}
});

test("text that only starts like a command is a message", async () => {
	const ran: string[] = [];
	const sent: string[] = [];
	await page.render(box([command(ran)], "app:agent.not-a-command", sent));
	for (const typed of ["/clear now", "please /clear", "/unknown"]) {
		await type(typed);
		await page.act(() => {
			page.container
				.querySelector("form")
				?.dispatchEvent(
					new Event("submit", { bubbles: true, cancelable: true }),
				);
		});
	}
	expect(ran).toEqual([]);
	expect(sent).toEqual(["/clear now", "please /clear", "/unknown"]);
});

test("a hidden command runs when typed but is not in the menu", async () => {
	const ran: string[] = [];
	const sent: string[] = [];
	await page.render(
		box([command(ran, { hidden: true })], "app:agent.hidden", sent),
	);
	await type("/");
	expect(menu()).toBeNull();
	await type("/clear");
	await press("Enter");
	expect(ran).toEqual(["clear"]);
	expect(sent).toEqual([]);
});

test("a room's /clear asks the same question as Start over, and restarts the room when confirmed", async () => {
	const ROOM = "app:agent.slash-clear-room";
	const startOver = spyOn(api, "startRoomOver").mockResolvedValue(
		undefined as never,
	);
	const history = spyOn(api, "messages").mockResolvedValue({
		messages: [],
		more: false,
		cards: [],
	});
	try {
		store.dispatch({ type: "rooms_loaded", rooms: [view(ROOM)] });
		await page.render(
			<ConfigContext.Provider value={config}>
				<RoomPage roomKey={ROOM} />
				<RoomConfirmHost />
			</ConfigContext.Provider>,
		);
		await page.act(() => settle(120));
		await type("/clear");
		expect(menu()?.textContent).toContain("/clear");
		await press("Enter");
		await page.act(() => settle(60));
		expect(said).toEqual([]);
		expect(startOver).not.toHaveBeenCalled();
		const dialog = [...document.querySelectorAll("dialog")].find(
			(one) =>
				one.open && one.getAttribute("aria-label") === "Start over Clearable?",
		);
		expect(dialog).toBeDefined();
		const confirm = [...(dialog?.querySelectorAll("button") ?? [])].find(
			(one) => one.textContent === "Start over",
		);
		await page.click(confirm ?? null);
		expect(startOver).toHaveBeenCalledWith(ROOM);
		expect(said).toEqual([]);
	} finally {
		startOver.mockRestore();
		history.mockRestore();
	}
});

test("a host's room refuses /clear with a notice instead of sending it", async () => {
	const sent: string[] = [];
	await page.render(
		<>
			<Toaster />
			{box([...hostRoomCommands], "app:agent.host-refuses", sent)}
		</>,
	);
	await type("/");
	expect(menu()).toBeNull();
	await type("/clear");
	await press("Enter");
	expect(sent).toEqual([]);
	expect(page.container.textContent).toContain("cannot be started over");
});
