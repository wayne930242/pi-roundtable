import { expect, spyOn, test } from "bun:test";
import { FolderDialogHost } from "./components/folder-dialogs.tsx";
import { RoomMenu } from "./components/room-menu.tsx";
import {
	all,
	BUILD,
	config,
	dialog,
	F1,
	foldersPage,
	HOME,
	List,
	labels,
	load,
	menuItems,
	page,
	rightClick,
	rowOf,
	SCOUT,
	settle,
	show,
	until,
	view,
	WORK,
} from "./folders-fixture.tsx";
import { store } from "./lib/app-store.ts";
import { ConfigContext } from "./lib/config.ts";
import { clearFolderDialog } from "./lib/folder-dialogs.ts";
import { layoutApi } from "./lib/layout-api.ts";
import { loadDragWith } from "./lib/row-press.ts";

foldersPage();

const RoomMenuFor = (props: { room: string; onClose?: () => void }) => (
	<ConfigContext.Provider value={config}>
		<RoomMenu
			open
			room={props.room}
			mode={{ yolo: false, longRunning: false }}
			onClose={props.onClose ?? (() => undefined)}
			onAskYolo={() => undefined}
			onAskStartOver={() => undefined}
		/>
		<FolderDialogHost />
	</ConfigContext.Provider>
);

const menuLabels = () => all(".menu-text strong").map((one) => one.textContent);

test("a room's own menu pins it and opens Move to folder…, and Home's has Pin but no Move to folder…", async () => {
	load({ pins: [BUILD] });
	await page.render(<RoomMenuFor room={SCOUT} />);
	expect(menuLabels()).toContain("Pin");
	expect(menuLabels()).toContain("Move to folder…");
	const pin = spyOn(layoutApi, "pinRoom").mockResolvedValue({
		pins: [BUILD, SCOUT],
		hidden: [],
		folders: [],
	});
	try {
		await page.click(
			all(".menu-link").find((one) => one.textContent?.includes("Pin")) ?? null,
		);
		await settle(80);
		expect(pin).toHaveBeenCalledWith(SCOUT, true, null);
	} finally {
		pin.mockRestore();
	}
	// A pinned room offers Unpin.
	await page.render(<RoomMenuFor room={BUILD} />);
	expect(menuLabels()).toContain("Unpin");
	// Move to folder… asks the folder dialog.
	await page.click(
		all(".menu-link").find((one) =>
			one.textContent?.includes("Move to folder"),
		) ?? null,
	);
	await settle(80);
	expect(dialog("Move to folder…")).toBeDefined();
	await page.act(() => clearFolderDialog());
	// Home can be pinned but not filed.
	await page.render(<RoomMenuFor room={HOME} />);
	expect(menuLabels()).toContain("Pin");
	expect(menuLabels()).not.toContain("Move to folder…");
	load({ pins: [HOME] });
	await page.render(<RoomMenuFor room={HOME} />);
	expect(menuLabels()).toContain("Unpin");
	expect(menuLabels()).not.toContain("Move to folder…");
});

// ── Lifting a row with a finger or a mouse ───────────────────────────────────────────────────

function pointer(
	target: Element,
	type: "pointerdown" | "pointermove" | "pointerup",
	over: {
		x?: number;
		y?: number;
		kind?: "touch" | "mouse";
		buttons?: number;
	} = {},
): void {
	const event = new PointerEvent(type, {
		bubbles: true,
		cancelable: true,
		clientX: over.x ?? 200,
		clientY: over.y ?? 300,
		pointerId: 1,
		pointerType: over.kind ?? "touch",
		isPrimary: true,
		buttons: over.buttons ?? 0,
	});
	target.dispatchEvent(event);
}

test("a row that can be lifted has a non-passive touchmove listener on the page before any finger is down, so iOS lets the lift stop the scroll", async () => {
	const added: [string, unknown][] = [];
	const removed: string[] = [];
	const add = window.addEventListener.bind(window);
	const remove = window.removeEventListener.bind(window);
	window.addEventListener = ((type: string, run: never, options?: never) => {
		added.push([type, options]);
		return add(type, run, options);
	}) as typeof window.addEventListener;
	window.removeEventListener = ((type: string, run: never, options?: never) => {
		removed.push(type);
		return remove(type, run, options);
	}) as typeof window.removeEventListener;
	try {
		load({ folders: [WORK] });
		await show(<List />);
		expect(
			added.filter(
				([type, options]) =>
					type === "touchmove" &&
					(options as { passive?: boolean } | undefined)?.passive === false,
			).length,
		).toBe(1);
		await page.render(null);
		expect(removed).toContain("touchmove");
	} finally {
		window.addEventListener = add;
		window.removeEventListener = remove;
	}
});

test("a finger that rests on a row lifts it, and letting go without moving opens its menu", async () => {
	load({ folders: [WORK] });
	await show(<List />);
	const row = rowOf("scout") as HTMLElement;
	const item = row.closest("li") as HTMLElement;
	await page.act(async () => {
		pointer(row, "pointerdown");
		await until(() => item.hasAttribute("data-lifted"));
	});
	expect(item.hasAttribute("data-lifted")).toBe(true);
	// The menu waits for the finger to lift: nothing is open while the row is held.
	expect(menuItems()).toEqual([]);
	await page.act(() => pointer(row, "pointerup"));
	await settle(80);
	expect(item.hasAttribute("data-lifted")).toBe(false);
	expect(labels().slice(0, 2)).toEqual(["Pin", "Move to folder…"]);
});

test("a lift whose chunk arrives after the finger has gone is a tap: nothing is held and the menu opens", async () => {
	load({ folders: [WORK] });
	await show(<List />);
	const row = rowOf("scout") as HTMLElement;
	const item = row.closest("li") as HTMLElement;
	let arrive: () => void = () => undefined;
	const restore = loadDragWith(
		() =>
			new Promise((resolve) => {
				arrive = () => resolve(import("./lib/drag.ts"));
			}),
	);
	try {
		// The hold fires at 450 ms; the finger lifts before the chunk is there.
		await page.act(async () => {
			pointer(row, "pointerdown");
			await settle(520);
		});
		await page.act(() => pointer(row, "pointerup"));
		await page.act(async () => {
			arrive();
			await until(() => menuItems().length > 0);
		});
		expect(item.hasAttribute("data-lifted")).toBe(false);
		// A lift would now be stopping every touchmove of the page.
		const scroll = new Event("touchmove", { bubbles: true, cancelable: true });
		window.dispatchEvent(scroll);
		expect(scroll.defaultPrevented).toBe(false);
		expect(labels().slice(0, 2)).toEqual(["Pin", "Move to folder…"]);
	} finally {
		restore();
	}
});

test("Android's contextmenu while the finger is down is the hold: the row lifts, the browser keeps its menu away, and letting go opens ours once", async () => {
	load({ folders: [WORK] });
	await show(<List />);
	const row = rowOf("scout") as HTMLElement;
	const item = row.closest("li") as HTMLElement;
	const system = new MouseEvent("contextmenu", {
		bubbles: true,
		cancelable: true,
		clientX: 200,
		clientY: 300,
	});
	await page.act(async () => {
		pointer(row, "pointerdown");
		// Android's own long press comes at about 400 ms, before the 450 ms hold.
		await settle(120);
		row.dispatchEvent(system);
		await until(() => item.hasAttribute("data-lifted"));
	});
	expect(system.defaultPrevented).toBe(true);
	expect(item.hasAttribute("data-lifted")).toBe(true);
	expect(menuItems()).toEqual([]);
	// The hold's own timer must not act on top of it.
	await page.act(async () => {
		await settle(500);
	});
	expect(menuItems()).toEqual([]);
	expect(item.hasAttribute("data-lifted")).toBe(true);
	await page.act(() => pointer(row, "pointerup"));
	await settle(80);
	expect(item.hasAttribute("data-lifted")).toBe(false);
	expect(labels().slice(0, 2)).toEqual(["Pin", "Move to folder…"]);
	expect(all('[role="menu"], dialog.sheet[open]').length).toBe(1);
	// The click some browsers send after the lift does not open the room.
	window.location.hash = "#/rooms";
	await page.click(row);
	expect(window.location.hash).toBe("#/rooms");
});

test("a mouse's right click is not a hold: it opens the menu at once, with no lift", async () => {
	load({ folders: [WORK] });
	await show(<List />);
	const row = rowOf("scout") as HTMLElement;
	await page.act(() =>
		pointer(row, "pointerdown", { kind: "mouse", buttons: 2 }),
	);
	await rightClick(row);
	expect(labels().slice(0, 2)).toEqual(["Pin", "Move to folder…"]);
	expect((row.closest("li") as HTMLElement).hasAttribute("data-lifted")).toBe(
		false,
	);
});

test("while a row is lifted the list keeps its order, and the latest order shows once it is dropped", async () => {
	const said = (room: string, at: string) => ({
		id: 1,
		room,
		kind: "agent" as const,
		author: "x",
		text: "hi",
		files: [],
		at,
	});
	const order = (newest: string) =>
		store.dispatch({
			type: "rooms_loaded",
			rooms: [
				view(HOME, { home: true }),
				view(SCOUT, {
					last: said(
						SCOUT,
						newest === SCOUT ? "2026-10-28T12:00:00Z" : "2026-10-28T10:00:00Z",
					),
				}),
				view(BUILD, {
					last: said(
						BUILD,
						newest === BUILD ? "2026-10-28T12:00:00Z" : "2026-10-28T10:00:00Z",
					),
				}),
			],
			pins: [],
			hidden: [],
			folders: [{ id: F1, name: "Work", rooms: [] }],
		});
	const names = () => all(".room-row strong").map((one) => one.textContent);
	order(BUILD);
	await show(<List />);
	expect(names()).toEqual(["guide", "build", "scout"]);
	const row = rowOf("scout") as HTMLElement;
	const item = row.closest("li") as HTMLElement;
	await page.act(async () => {
		pointer(row, "pointerdown");
		await until(() => item.hasAttribute("data-lifted"));
	});
	expect(item.hasAttribute("data-lifted")).toBe(true);
	// A message arrives in the room under the finger: the rows do not move under it.
	await page.act(async () => {
		order(SCOUT);
		await settle(60);
	});
	expect(names()).toEqual(["guide", "build", "scout"]);
	await page.act(() => pointer(row, "pointerup"));
	await settle(80);
	expect(names()).toEqual(["guide", "scout", "build"]);
});

test("a finger that goes down within 32 px of a screen edge never lifts a row: the hold opens the menu as before", async () => {
	await show(<List />);
	const row = rowOf("scout") as HTMLElement;
	// The menu opens from a timer, so the wait is inside `act` for React to draw it.
	await page.act(async () => {
		pointer(row, "pointerdown", { x: 10 });
		await until(() => menuItems().length > 0);
	});
	expect((row.closest("li") as HTMLElement).hasAttribute("data-lifted")).toBe(
		false,
	);
	expect(labels().slice(0, 2)).toEqual(["Pin", "Move to folder…"]);
});

test("a mouse lifts a row once it moves with the button down, and the click after the drop does not open the row", async () => {
	window.location.hash = "#/rooms";
	load({ folders: [WORK] });
	await show(<List />);
	const row = rowOf("scout") as HTMLElement;
	const item = row.closest("li") as HTMLElement;
	await page.act(() =>
		pointer(row, "pointerdown", { kind: "mouse", buttons: 1 }),
	);
	await page.act(() =>
		pointer(row, "pointermove", { kind: "mouse", buttons: 1, y: 320 }),
	);
	await settle(80);
	expect(item.hasAttribute("data-lifted")).toBe(true);
	await page.act(() => pointer(row, "pointerup", { kind: "mouse", y: 320 }));
	await page.click(row);
	expect(window.location.hash).toBe("#/rooms");
	// The next click is an ordinary one again.
	expect(item.hasAttribute("data-lifted")).toBe(false);
});

test("a menu row lays out as a row even when it is a label, which the form rules make a column", async () => {
	const css = await Bun.file(new URL("./styles.css", import.meta.url)).text();
	const rule = (selector: string) =>
		css.match(new RegExp(`\\n${selector} \\{([^}]*)\\}`))?.[1] ?? "";
	expect(rule("label")).toContain("flex-direction: column");
	expect(rule("\\.menu-item")).toContain("flex-direction: row");
});

test("the room list's header buttons share one borderless style", async () => {
	await show(<List />);
	const css = await Bun.file(new URL("./app.css", import.meta.url)).text();
	const rule = css.match(/\n\.header-button \{([^}]*)\}/)?.[1];
	expect(rule).toContain("border-color: transparent");
	expect(rule).toContain("color: var(--text)");
	const buttons = all(".page-head .actions > button");
	expect(buttons.length).toBeGreaterThanOrEqual(2);
	expect(buttons.every((one) => one.classList.contains("header-button"))).toBe(
		true,
	);
});
