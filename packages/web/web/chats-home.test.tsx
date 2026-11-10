import { expect, spyOn, test } from "bun:test";
import type { PromptFrame, RoomMessage } from "../src/api-types.ts";
import {
	archived,
	F1,
	F2,
	GUIDE,
	Home,
	loadChats,
	NEWS,
	QUIET,
	seed,
	T1,
	T2,
} from "./chats-fixture.tsx";
import {
	all,
	BUILD,
	foldersPage,
	page,
	q,
	SCOUT,
	until,
	view,
} from "./folders-fixture.tsx";
import { store } from "./lib/app-store.ts";
import { setHomeMode } from "./lib/home-mode.ts";
import { layoutApi } from "./lib/layout-api.ts";

foldersPage();

const show = async (node: React.ReactNode) => {
	await page.render(node);
	await until(() => q(".chats") !== null && all(".chat-row, .pin").length > 0);
};
const said = (room: string, id: number, at: string): RoomMessage => ({
	id,
	room,
	kind: "agent",
	agent: room.slice(room.indexOf(".") + 1),
	author: "x",
	text: `hello from ${room}`,
	files: [],
	at,
});
const say = (room: string, id: number, at: string) =>
	page.act(() => {
		store.dispatch({ type: "message", room, message: said(room, id, at) });
	});
const names = (selector: string) => all(selector).map((one) => one.textContent);

test("the pins are the pinned rooms in order, each with its name under it; Home is no pin and leads the list", async () => {
	seed();
	loadChats({ pins: [BUILD, SCOUT] });
	await show(<Home />);
	expect(names(".pin-name")).toEqual(["build", "scout"]);
	// Pinned rooms are not in the list below them; Home is its first row.
	const rows = names(".chat-row strong");
	expect(rows[0]).toBe("guide");
	expect(rows.slice(1).sort()).toEqual(["news", "team"]);
});

test("a figure stands free on its accent badge: no drawn frame or clip, the accent on the host, in the pins and in the rows", async () => {
	seed();
	loadChats({ pins: [SCOUT] });
	await show(<Home />);
	await until(() => q(".pin .av-host svg") !== null);
	const figures = all(".pin .av-host, .chat-row .av-host");
	expect(figures.length).toBeGreaterThan(3);
	for (const figure of figures) {
		expect(figure.hasAttribute("data-bare")).toBe(true);
		expect(figure.hasAttribute("data-badge")).toBe(true);
		expect(
			(figure as HTMLElement).style.getPropertyValue("--av-accent"),
		).toMatch(/^#[0-9a-f]{6}$/);
		expect(figure.querySelector(".ring")).toBeNull();
		expect(figure.querySelector("clipPath")).toBeNull();
	}
});

test("a pin's corner shows the waiting cards before the unread messages, and those before the working dot", async () => {
	loadChats({ pins: [BUILD, SCOUT, NEWS] });
	seed(0, { [BUILD]: 4, [SCOUT]: 3 });
	const card: PromptFrame = {
		id: "p1",
		kind: "approval",
		title: "Run?",
		message: "Run",
		purpose: "action",
	};
	store.dispatch({ type: "prompt", room: SCOUT, prompt: card });
	store.dispatch({
		type: "activity",
		room: SCOUT,
		typing: true,
		stoppable: true,
	});
	store.dispatch({
		type: "activity",
		room: NEWS,
		typing: true,
		stoppable: true,
	});
	await show(<Home />);
	const of = (room: string) => q(`[data-room-pin="${room}"]`);
	// Scout: a card waits (and it is unread and working too): the card wins.
	expect(
		of(SCOUT)?.querySelector(".pin-count")?.getAttribute("data-kind"),
	).toBe("waiting");
	expect(of(SCOUT)?.querySelector(".pin-dot")).toBeNull();
	// Build: unread only.
	const build = of(BUILD)?.querySelector(".pin-count");
	expect(build?.getAttribute("data-kind")).toBe("unread");
	expect(build?.textContent).toBe("4");
	// News: working only, a dot.
	expect(of(NEWS)?.querySelector(".pin-count")).toBeNull();
	expect(of(NEWS)?.querySelector(".pin-dot")).not.toBeNull();
	store.dispatch({ type: "prompt_closed", prompt: "p1", outcome: "approved" });
});

test("there are no chips without a folder; with folders a chip filters the one list, and a count marks a folder with unread", async () => {
	loadChats({});
	seed(0, { [NEWS]: 2 });
	await show(<Home />);
	expect(q(".chips")).toBeNull();
	loadChats({
		folders: [
			{ id: F1, name: "Work", rooms: [SCOUT] },
			{ id: F2, name: "Play", rooms: [NEWS] },
		],
	});
	seed(0, { [NEWS]: 2 });
	await show(<Home />);
	await until(() => q(".chips") !== null);
	expect(names(".chip-label")).toEqual(["All", "Work", "Play", "Other"]);
	// News has unread messages: its folder's chip has the count, the others do not.
	const faces = all(".chip");
	expect(faces.map((one) => one.querySelector(".chip-count") !== null)).toEqual(
		[false, false, true, false],
	);
	expect(
		names(".chat-list:not(.elsewhere-list) .chat-row strong").sort(),
	).toEqual(["build", "guide", "news", "scout", "team"]);
	await page.click(all(".chip")[2] ?? null);
	expect(names(".chat-list:not(.elsewhere-list) .chat-row strong")).toEqual([
		"news",
	]);
	expect(all(".chip")[2]?.getAttribute("aria-pressed")).toBe("true");
	await page.click(all(".chip")[3] ?? null);
	expect(
		names(".chat-list:not(.elsewhere-list) .chat-row strong").sort(),
	).toEqual(["build", "team"]);
	await page.click(all(".chip")[0] ?? null);
	expect(all(".chat-row").length).toBe(5);
});

test("the list is by latest activity and a message moves its room up at once", async () => {
	seed();
	loadChats({});
	await show(<Home />);
	await say(BUILD, 1, "2026-10-30T10:00:00.000Z");
	await say(NEWS, 1, "2026-10-30T11:00:00.000Z");
	// Home stays first whatever spoke last.
	expect(names(".chat-row strong").slice(0, 3)).toEqual([
		"guide",
		"news",
		"build",
	]);
	await say(BUILD, 2, "2026-10-30T12:00:00.000Z");
	expect(names(".chat-row strong").slice(0, 3)).toEqual([
		"guide",
		"build",
		"news",
	]);
	// One line of the last message is the preview.
	expect(q(`[data-room="${BUILD}"] .chat-preview`)?.textContent).toBe(
		`hello from ${BUILD}`,
	);
});

test("a row has no nested threads: dispatch threads are only a count, and the threads are no rows", async () => {
	seed();
	loadChats({}, [
		view(GUIDE, { home: true }),
		view(SCOUT),
		view(T1, { kind: "thread", parent: SCOUT, readOnly: true }),
		view(T2, { kind: "thread", parent: SCOUT, readOnly: true }),
	]);
	await show(<Home />);
	expect(names(".chat-row strong")).toEqual(["guide", "scout"]);
	expect(q(".thread-group, .helper-link")).toBeNull();
	expect(
		q(`[data-room="${SCOUT}"] .chat-pill[data-kind="threads"]`)?.textContent,
	).toBe("2 threads");
});

test("hidden rooms are off the home, which has no row or link to the hidden page; the features grid is the way in", async () => {
	loadChats({ hidden: [QUIET, NEWS] }, [
		...[GUIDE, SCOUT, NEWS].map((key) =>
			view(key, key === GUIDE ? { home: true } : {}),
		),
		view(QUIET),
	]);
	seed(4, { [QUIET]: 1 });
	await show(<Home />);
	await new Promise((resolve) => setTimeout(resolve, 60));
	expect(names(".chat-row strong")).toEqual(["guide", "scout"]);
	expect(q(".hidden-row")).toBeNull();
	expect(q('a[href="#/hidden"]')).toBeNull();
	await page.click(q(".chats-grid"));
	await until(() => all(".feature-tile").length > 0);
	expect(names(".feature-label")).toContain("Hidden and archived");
});

test("the open room's row is marked and the column version has four pins to a row", async () => {
	seed();
	loadChats({ pins: [BUILD] });
	await show(<Home active={NEWS} column />);
	expect(q(`[data-room="${NEWS}"]`)?.getAttribute("aria-current")).toBe("page");
	expect(q(".chats")?.hasAttribute("data-column")).toBe(true);
});

test("the grid button opens all features, grouped from the config's panes, with the cards waiting on its tile", async () => {
	const stub = seed();
	loadChats({});
	store.dispatch({
		type: "prompt",
		room: SCOUT,
		prompt: {
			id: "p2",
			kind: "approval",
			title: "Run?",
			message: "Run",
			purpose: "action",
		},
	});
	await show(<Home />);
	await page.click(q(".chats-grid"));
	await until(() => all(".feature-tile").length > 0);
	// The dialog's own class is `features`: the groups' container must not share it, or the
	// container's flex layout shows the closed dialog.
	expect(
		q("dialog.sheet.features > .sheet-body .feature-groups"),
	).not.toBeNull();
	expect(names(".feature-group h3")).toEqual([
		"Organize",
		"Work",
		"Knights",
		"System",
	]);
	const tiles = names(".feature-label");
	for (const label of [
		"Folders and order",
		"Schedules",
		"Waiting",
		"Hidden and archived",
		"Files",
		"Round table",
		"Notes",
		"Skills",
		"Settings",
		"Profile",
	])
		expect(tiles).toContain(label);
	// Panes the host does not serve have no tile.
	expect(tiles).not.toContain("Webhooks");
	expect(q(".feature-badge")?.textContent).toBe("1");
	store.dispatch({ type: "prompt_closed", prompt: "p2", outcome: "approved" });
	stub.mockRestore();
});

test("hiding from the home is the layout API's; the home applies the server's answer", async () => {
	const hide = spyOn(layoutApi, "hideRoom").mockResolvedValue({
		pins: [],
		hidden: [NEWS],
		folders: [],
	});
	seed();
	loadChats({});
	const { hideRoom } = await import("./lib/layout-actions.ts");
	await show(<Home />);
	await page.act(async () => {
		await hideRoom(NEWS, true);
	});
	expect(hide).toHaveBeenCalledWith(NEWS, true);
	expect(names(".chat-row strong")).not.toContain("news");
	hide.mockRestore();
	setHomeMode("rooms");
	expect(archived(2)).toHaveLength(2);
});
