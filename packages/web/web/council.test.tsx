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
	GroupProfileView,
	RoomView,
} from "../src/api-types.ts";
import { ActionMenuHost } from "./components/action-menu.tsx";
import { RoomConfirmHost } from "./components/room-confirms.tsx";
import { openPage, releaseDom, type TestPage } from "./dom.ts";
import { closeMenu } from "./lib/action-menu.ts";
import { api } from "./lib/api.ts";
import { store } from "./lib/app-store.ts";
import { ConfigContext } from "./lib/config.ts";
import {
	chooseCouncil,
	councilOf,
	hostOf,
	membersOf,
	resetCouncilChoice,
	slugFor,
	startingTicks,
	toggled,
} from "./lib/council.ts";
import { loadKit } from "./lib/kit.ts";
import { seatMenuOf } from "./lib/menus.ts";
import { clearRoomConfirm } from "./lib/room-confirm.ts";
import { setRouting } from "./lib/router.ts";
import { type AppConnection, setConnection } from "./lib/socket.ts";
import { resetTableView, TABLE_MODE_KEY } from "./lib/table-view.ts";
import { teamApi } from "./lib/team-api.ts";
import { TablePage } from "./pages/table.tsx";

const config: ConfigView = {
	title: "Console",
	panes: ["table"],
	timeZone: "UTC",
	look: "modern",
};

const NAMES = [
	"guide",
	"scout",
	"mason",
	"cook",
	"nurse",
	"pilot",
	"smith",
	"baker",
	"clerk",
];

const agent = (name: string, over: Partial<RoomView> = {}): RoomView => ({
	key: `app:agent.${name}`,
	kind: "agent",
	name,
	displayName: name,
	home: name === "guide",
	readOnly: false,
	mode: { yolo: false, longRunning: false },
	typing: false,
	stoppable: false,
	...over,
});

const group = (
	name: string,
	members: string[],
	over: Partial<RoomView> = {},
): RoomView => ({
	key: `app:group.${name}`,
	kind: "group",
	name,
	displayName: name[0]?.toUpperCase() + name.slice(1),
	home: false,
	readOnly: false,
	members,
	mode: { yolo: false, longRunning: false },
	typing: false,
	stoppable: false,
	...over,
});

const everyone = NAMES.map((name) => agent(name));
const profileOf = (
	name: string,
	members: string[],
	host = members[0] ?? "",
): GroupProfileView => ({
	name,
	displayName: name,
	members,
	host,
	room: `app:group.${name}`,
});

// ── the pure rules ───────────────────────────────────────────────────────────────────────────

test("the address, then the council this device chose, then the first group is what the table shows", () => {
	const crew = group("crew", ["guide", "scout"]);
	const ops = group("ops", ["mason", "cook"]);
	expect(councilOf([crew, ops], undefined)?.name).toBe("crew");
	expect(councilOf([crew, ops], ops.key)?.name).toBe("ops");
	expect(councilOf([crew, ops], ops.key, "crew")?.name).toBe("crew");
	expect(councilOf([crew, ops], undefined, ops.key)?.name).toBe("ops");
	// a choice that is gone (archived) falls back to the first group
	expect(councilOf([crew, ops], "app:group.gone")?.name).toBe("crew");
	expect(councilOf([], "app:group.crew")).toBeUndefined();
});

test("with no council the sheet starts from the agents that were not muted, the coordinator first, eight at most", () => {
	const list = [
		agent("scout", { muted: true }),
		agent("mason"),
		...NAMES.slice(3).map((name) => agent(name)),
		agent("guide"),
	];
	const ticks = startingTicks(list);
	expect(ticks).toHaveLength(8);
	expect(ticks[0]).toBe("guide");
	expect(ticks).not.toContain("scout");
});

test("ticks keep the order they were made in, and the ninth is not taken", () => {
	let ticked: string[] = [];
	for (const name of NAMES.slice(0, 8)) ticked = toggled(ticked, name);
	expect(ticked).toEqual(NAMES.slice(0, 8));
	expect(toggled(ticked, "clerk")).toEqual(ticked);
	expect(toggled(ticked, "mason")).toEqual(
		NAMES.slice(0, 8).filter((name) => name !== "mason"),
	);
	// a tick that comes back goes last
	expect(toggled(toggled(ticked, "guide"), "guide").at(-1)).toBe("guide");
});

test("members are the ticks that still exist, at most eight, and the host stays unless it left", () => {
	expect(membersOf(["a", "b", "gone", "c"], (name) => name !== "gone")).toEqual(
		["a", "b", "c"],
	);
	expect(membersOf(NAMES.concat("x"), () => true)).toHaveLength(8);
	expect(hostOf(["a", "b"], "b", "a")).toBe("b");
	expect(hostOf(["a", "b"], "c", "b")).toBe("b");
	expect(hostOf(["a", "b"], undefined, "z")).toBe("a");
	expect(hostOf([], undefined, undefined)).toBe("");
});

test("a new council's permanent name comes from its name, and is free among the names there are", () => {
	expect(slugFor("Night Watch", new Set())).toBe("night-watch");
	expect(slugFor("Night Watch", new Set(["night-watch"]))).toBe(
		"night-watch-2",
	);
	// a name with no letter or digit in it still gets one
	expect(slugFor("\u8a55\u8b70\u6703", new Set())).toBe("council");
	expect(slugFor("\u8a55\u8b70\u6703", new Set(["council", "council-2"]))).toBe(
		"council-3",
	);
});

// ── the page ─────────────────────────────────────────────────────────────────────────────────

let page: TestPage;
let messages: ReturnType<typeof spyOn>;
let rooms: ReturnType<typeof spyOn>;
const realMatchMedia = globalThis.matchMedia;
const sent: unknown[] = [];
const said: Array<{ room: string; text: string }> = [];
/** The screen is a phone's: narrow, and touched. */
let phone = false;

beforeAll(async () => {
	await loadKit();
	// Lazy chunks the page asks for are loaded first, so no test depends on the clock or on another file.
	await import("./components/council-sheet.tsx");
	await import("./lib/menu-items.ts");
	page = await openPage();
	setRouting(undefined);
	window.matchMedia = ((query: string) => ({
		matches:
			phone &&
			(query.includes("max-width: 719px") || query.includes("pointer: coarse")),
		media: query,
		addEventListener: () => undefined,
		removeEventListener: () => undefined,
		addListener: () => undefined,
		removeListener: () => undefined,
		dispatchEvent: () => false,
		onchange: null,
	})) as typeof window.matchMedia;
});
afterAll(async () => {
	window.matchMedia = realMatchMedia;
	setConnection(undefined);
	await page.unmount();
	await releaseDom();
});
beforeEach(() => {
	sent.length = 0;
	said.length = 0;
	phone = false;
	resetCouncilChoice();
	window.localStorage.clear();
	resetTableView();
	window.location.hash = "#/table";
	setConnection(
		partial<AppConnection>({
			send: (frame) => {
				sent.push(frame);
				return true;
			},
			focus: () => undefined,
			say: (room: string, text: string) => {
				said.push({ room, text });
				return true;
			},
		}),
	);
	messages = spyOn(api, "messages").mockResolvedValue({
		messages: [],
		more: false,
		cards: [],
	});
	rooms = spyOn(api, "rooms").mockImplementation(async () => ({
		pins: [],
		folders: [],
		rooms: Object.values(store.getState().rooms).flatMap((room) =>
			room.view ? [room.view] : [],
		),
	}));
});
afterEach(async () => {
	messages.mockRestore();
	rooms.mockRestore();
	closeMenu();
	clearRoomConfirm();
	await page.render(null);
	store.dispatch({ type: "rooms_loaded", rooms: [] });
	window.location.hash = "";
});

const load = (list: RoomView[]) =>
	store.dispatch({ type: "rooms_loaded", rooms: list });
const settle = (ms = 80) =>
	page.act(() => new Promise((done) => setTimeout(done, ms)));
const q = <T extends Element>(selector: string): T | null =>
	document.querySelector<T>(selector);
const all = <T extends Element>(selector: string): T[] => [
	...document.querySelectorAll<T>(selector),
];
const button = (text: string): HTMLButtonElement | undefined =>
	all<HTMLButtonElement>("button").find((one) =>
		one.textContent?.trim().startsWith(text),
	);
const typeInto = (element: HTMLInputElement | null, text: string) =>
	page.act(() => {
		if (!element) throw new Error("nothing to type into");
		Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value",
		)?.set?.call(element, text);
		element.dispatchEvent(new Event("input", { bubbles: true }));
	});
const ticks = () =>
	all<HTMLInputElement>('.council-sheet input[type="checkbox"]');
const tickOf = (name: string) =>
	ticks().find(
		(box) =>
			box.closest("label")?.querySelector("strong")?.textContent === name,
	);

const show = async () => {
	await page.render(
		<ConfigContext.Provider value={config}>
			<TablePage />
			<ActionMenuHost />
			<RoomConfirmHost />
		</ConfigContext.Provider>,
	);
	await settle();
};

test("with no group at all the table says there is no council, and the sheet starts from the unmuted agents", async () => {
	load(
		everyone.map((one) =>
			one.name === "scout" ? { ...one, muted: true as const } : one,
		),
	);
	await show();
	expect(page.container.textContent).toContain("No council yet");
	expect(all("g.seat")).toHaveLength(0);
	await page.click(button("Pick who sits") ?? null);
	await settle();
	const on = ticks().filter((box) => box.checked);
	// eight of the eight unmuted, the coordinator first; the muted one is not ticked
	expect(on).toHaveLength(8);
	expect(tickOf("scout")?.checked).toBe(false);
	expect(q(".council-count")?.textContent).toContain("8 of 8 picked");
	expect(q(".council-count")?.textContent).toContain("At most 8 knights");
	// a council is made by naming it
	expect(button("Make council")?.disabled).toBe(true);
});

test("a temp knight is not in the tick list, the starting ticks or the seats of the table", async () => {
	const helper = agent("scout-1", {
		helper: { parent: "app:agent.scout", parentName: "scout" },
	});
	expect(startingTicks([...everyone.slice(0, 3), helper])).toEqual([
		"guide",
		"scout",
		"mason",
	]);
	load([...everyone.slice(0, 3), helper]);
	await show();
	await page.click(button("Pick who sits") ?? null);
	await settle();
	expect(tickOf("scout-1")).toBeUndefined();
	expect(ticks()).toHaveLength(3);
});

test("saving the first council makes a group, puts it on the table and its address", async () => {
	load(everyone.slice(0, 3));
	const create = spyOn(teamApi, "createGroup").mockImplementation(
		async (made) => {
			load([...everyone.slice(0, 3), group(made.name, made.members)]);
			return profileOf(made.name, made.members, made.host);
		},
	);
	// once the new group is on the table the sheet, still closing, reads its profile
	const profile = spyOn(teamApi, "group").mockImplementation(async (name) =>
		profileOf(name, ["guide", "scout", "mason"]),
	);
	try {
		await show();
		await page.click(button("Pick who sits") ?? null);
		await settle();
		await typeInto(
			q<HTMLInputElement>(
				'.council-sheet input[type="text"], .council-sheet label input:not([type])',
			),
			"Night Watch",
		);
		await page.click(button("Make council") ?? null);
		await settle();
		expect(create).toHaveBeenCalledWith({
			name: "night-watch",
			displayName: "Night Watch",
			members: ["guide", "scout", "mason"],
			host: "guide",
		});
		expect(decodeURIComponent(window.location.hash)).toBe(
			"#/table/night-watch",
		);
		expect(window.localStorage.getItem("rt-table-council")).toBe(
			"app:group.night-watch",
		);
	} finally {
		profile.mockRestore();
		create.mockRestore();
	}
});

test("a group is a council: the chip names it, only its members sit, and picking another switches the table", async () => {
	load([
		...everyone,
		group("crew", ["guide", "scout", "mason"]),
		group("ops", ["cook", "nurse"]),
	]);
	const profile = spyOn(teamApi, "group").mockResolvedValue(
		profileOf("crew", ["guide", "scout", "mason"]),
	);
	try {
		await show();
		expect(button("Council: Crew")).toBeDefined();
		expect(all("g.seat")).toHaveLength(3);
		await page.click(button("Council: Crew") ?? null);
		await settle();
		const rows = all<HTMLButtonElement>(".council-row");
		expect(rows.map((row) => row.querySelector("strong")?.textContent)).toEqual(
			["Crew", "Ops"],
		);
		expect(rows[0]?.getAttribute("aria-current")).toBe("true");
		await page.click(rows[1] ?? null);
		expect(decodeURIComponent(window.location.hash)).toBe("#/table/ops");
		expect(window.localStorage.getItem("rt-table-council")).toBe(
			"app:group.ops",
		);
		expect(button("Council: Ops")).toBeDefined();
		// the seats that leave glide out of the ring before they are gone
		for (let tries = 0; tries < 30 && all("g.seat").length !== 2; tries += 1)
			await settle();
		expect(
			all("g.seat").map((seat) => seat.getAttribute("aria-label")),
		).toEqual(["cook (idle)", "nurse (idle)"]);
	} finally {
		profile.mockRestore();
	}
});

test("the council this device chose is what the table shows when the address names none", async () => {
	load([
		...everyone,
		group("crew", ["guide", "scout"]),
		group("ops", ["cook", "nurse", "pilot"]),
	]);
	chooseCouncil("app:group.ops");
	await show();
	expect(all("g.seat")).toHaveLength(3);
});

test("ticking edits the council in place: the ninth tick is refused, and Done sends the members in the order ticked", async () => {
	load([...everyone, group("crew", ["guide", "scout", "mason"])]);
	const profile = spyOn(teamApi, "group").mockResolvedValue(
		profileOf("crew", ["guide", "scout", "mason"], "scout"),
	);
	const update = spyOn(teamApi, "updateGroup").mockResolvedValue(
		profileOf("crew", ["guide", "scout", "mason", "cook", "nurse"]),
	);
	try {
		await show();
		await page.click(button("Council: Crew") ?? null);
		await settle();
		expect(q(".council-count")?.textContent).toContain("3 of 8 picked");
		expect(button("Done")?.disabled).toBe(true);
		// the council's host shows as pressed
		await page.click(tickOf("nurse") ?? null);
		await page.click(tickOf("cook") ?? null);
		expect(q(".council-count")?.textContent).toContain("5 of 8 picked");
		for (const name of ["pilot", "smith", "baker"])
			await page.click(tickOf(name) ?? null);
		expect(q(".council-count")?.textContent).toContain("At most 8 knights");
		expect(tickOf("clerk")?.disabled).toBe(true);
		await page.click(tickOf("baker") ?? null);
		await page.click(tickOf("smith") ?? null);
		await page.click(tickOf("pilot") ?? null);
		await page.click(button("Done") ?? null);
		await settle();
		// no host change: the council's host is still one of its members
		expect(update).toHaveBeenCalledWith("crew", {
			members: ["guide", "scout", "mason", "nurse", "cook"],
		});
	} finally {
		update.mockRestore();
		profile.mockRestore();
	}
});

test("Save as a new council keeps the old one and makes another group from the ticks", async () => {
	load([...everyone, group("crew", ["guide", "scout"])]);
	const profile = spyOn(teamApi, "group").mockResolvedValue(
		profileOf("crew", ["guide", "scout"]),
	);
	const update = spyOn(teamApi, "updateGroup");
	const create = spyOn(teamApi, "createGroup").mockImplementation(
		async (made) => {
			load([
				...everyone,
				group("crew", ["guide", "scout"]),
				group(made.name, made.members),
			]);
			return profileOf(made.name, made.members, made.host);
		},
	);
	try {
		await show();
		await page.click(button("Council: Crew") ?? null);
		await settle();
		await page.click(tickOf("mason") ?? null);
		await page.click(button("Save as a new council") ?? null);
		await typeInto(
			q<HTMLInputElement>(".council-sheet label input:not([type])"),
			"Crew",
		);
		await page.click(button("Save as a new council") ?? null);
		await settle();
		expect(update).not.toHaveBeenCalled();
		// the permanent name is free among the groups and the agents
		expect(create).toHaveBeenCalledWith({
			name: "crew-2",
			displayName: "Crew",
			members: ["guide", "scout", "mason"],
			host: "guide",
		});
	} finally {
		create.mockRestore();
		update.mockRestore();
		profile.mockRestore();
	}
});

test("a council made of a group that has no member left says so and offers the tick list", async () => {
	load([...everyone, group("crew", ["ghost", "other"])]);
	await show();
	expect(page.container.textContent).toContain("The council is empty");
	expect(button("Edit this council")).toBeDefined();
});

test("an address that names no group goes back to the plain table in place", async () => {
	load([...everyone, group("crew", ["guide", "scout"])]);
	window.location.hash = "#/table/ghost";
	await page.render(
		<ConfigContext.Provider value={config}>
			<TablePage focus="ghost" />
		</ConfigContext.Provider>,
	);
	await settle();
	expect(window.location.hash).toBe("#/table");
});

test("a seat's menu has the private chat and takes the knight out of the council, without muting it", async () => {
	load([...everyone, group("crew", ["guide", "scout", "mason"])]);
	const profile = spyOn(teamApi, "group").mockResolvedValue(
		profileOf("crew", ["guide", "scout", "mason"], "scout"),
	);
	const update = spyOn(teamApi, "updateGroup").mockResolvedValue(
		profileOf("crew", ["guide", "mason"]),
	);
	const mute = spyOn(api, "setMute");
	try {
		const menu = await seatMenuOf("app:agent.scout", "app:group.crew");
		expect(menu?.items.map((item) => item.id)).toEqual(["chat", "leave"]);
		await page.act(async () => {
			await menu?.items.find((item) => item.id === "leave")?.run();
		});
		// the host left with the knight, so the first member left takes it
		expect(update).toHaveBeenCalledWith("crew", {
			members: ["guide", "mason"],
			host: "guide",
		});
		expect(mute).not.toHaveBeenCalled();
		await page.act(async () => {
			await menu?.items.find((item) => item.id === "chat")?.run();
		});
		expect(decodeURIComponent(window.location.hash)).toBe(
			"#/room/app:agent.scout",
		);
	} finally {
		mute.mockRestore();
		update.mockRestore();
		profile.mockRestore();
	}
});

test("the last two members cannot be taken out: the council is offered for archiving instead", async () => {
	load([...everyone, group("pair", ["guide", "scout"])]);
	const update = spyOn(teamApi, "updateGroup");
	try {
		await show();
		const menu = await seatMenuOf("app:agent.scout", "app:group.pair");
		await page.act(async () => {
			await menu?.items.find((item) => item.id === "leave")?.run();
		});
		expect(update).not.toHaveBeenCalled();
		await settle();
		expect(document.body.textContent).toContain("Pair");
	} finally {
		update.mockRestore();
	}
});

test("a running round lights who speaks, turns the camera there, marks the seats and fills the strip above the box", async () => {
	load([...everyone, group("crew", ["guide", "scout", "mason"])]);
	await show();
	const crewRoom = "app:group.crew";
	await page.act(() => {
		store.dispatch({
			type: "activity",
			room: crewRoom,
			typing: true,
			stoppable: true,
		});
		store.dispatch({
			type: "round",
			room: crewRoom,
			round: {
				id: 3,
				state: "running",
				current: "scout",
				next: ["mason"],
				spoken: ["guide"],
				replies: 1,
				limit: 8,
			},
		});
	});
	for (
		let tries = 0;
		tries < 30 && all("g.seat[data-focus]").length === 0;
		tries += 1
	)
		await settle();
	// the member the round names thinks while no word of theirs has come: no light yet
	const states = () =>
		Object.fromEntries(
			all("g.seat").map((seat) => [
				seat.getAttribute("data-seat"),
				seat.getAttribute("data-state"),
			]),
		);
	expect(states()).toEqual({
		guide: "idle",
		scout: "thinking",
		mason: "idle",
	});
	expect(q(".t2d.dim")).toBeNull();
	expect(
		all("g.seat[data-focus]").map((seat) => seat.getAttribute("data-seat")),
	).toEqual(["scout"]);
	// the seats wear the same signs as the strip
	const plate = (name: string) =>
		all<SVGTextElement>(`g.seat[data-seat="${name}"] text`).at(0)?.textContent;
	expect(plate("guide")).toBe("✓ guide");
	expect(plate("mason")).toBe("① mason");
	expect(plate("scout")).toBe("scout");
	expect(q(".scene-box .order-strip .order-chip")?.textContent).toBe(
		"Reply 2 of 8",
	);
	// Stop ends the whole round, and says so
	expect(
		q<HTMLButtonElement>(".composer-stop")?.getAttribute("aria-label"),
	).toBe("Stop the round");
	await page.click(q<HTMLButtonElement>(".composer-stop"));
	expect(sent).toContainEqual({ type: "stop", room: crewRoom });
});

test("a member speaks while its words show in the box, and only then: thinking, speaking, idle", async () => {
	load([...everyone, group("crew", ["guide", "scout", "mason"])]);
	await show();
	const crewRoom = "app:group.crew";
	const scout = () =>
		q('g.seat[data-seat="scout"]')?.getAttribute("data-state");
	const until = async (check: () => boolean) => {
		for (let tries = 0; tries < 40 && !check(); tries += 1) await settle(50);
	};
	await page.act(() => {
		store.dispatch({ type: "focused", room: crewRoom });
		store.dispatch({
			type: "activity",
			room: crewRoom,
			typing: true,
			stoppable: true,
		});
		store.dispatch({
			type: "round",
			room: crewRoom,
			round: {
				id: 4,
				state: "running",
				current: "scout",
				next: [],
				spoken: [],
				replies: 0,
				limit: 8,
			},
		});
	});
	await until(() => scout() === "thinking");
	expect(scout()).toBe("thinking");
	expect(q(".t2d.dim")).toBeNull();
	// its words stream into the box: the light comes on
	await page.act(() => {
		store.dispatch({
			type: "progress",
			room: crewRoom,
			event: { type: "text", delta: "Three leads found." },
		});
	});
	await until(() => scout() === "speaking");
	expect(scout()).toBe("speaking");
	expect(q(".t2d.dim")).not.toBeNull();
	// the turn ends and the stored reply has shown whole: the light goes off
	await page.act(() => {
		store.dispatch({
			type: "message",
			room: crewRoom,
			message: {
				id: 9,
				room: crewRoom,
				kind: "agent",
				agent: "scout",
				author: "scout",
				text: "Three leads found.",
				files: [],
				at: "2026-10-31T10:00:00.000Z",
			},
		});
		store.dispatch({
			type: "activity",
			room: crewRoom,
			typing: false,
			stoppable: false,
		});
		store.dispatch({
			type: "round",
			room: crewRoom,
			round: {
				id: 4,
				state: "ended",
				ended: "done",
				next: [],
				spoken: ["scout"],
				replies: 1,
				limit: 8,
			},
		});
	});
	await until(() => scout() === "idle");
	expect(scout()).toBe("idle");
	expect(q(".t2d.dim")).toBeNull();
	await page.act(() => {
		store.dispatch({ type: "focused", room: undefined });
	});
});

// ── the composer and the display mode of the table page ──────────────────────────────────────

/** Types into the page's composer, with the focus in it as a person's typing puts it, and sends. */
async function sendFromBox(text: string): Promise<HTMLTextAreaElement> {
	const box = q<HTMLTextAreaElement>("textarea");
	if (!box) throw new Error("no composer");
	await page.act(() => {
		box.focus();
		Object.getOwnPropertyDescriptor(
			HTMLTextAreaElement.prototype,
			"value",
		)?.set?.call(box, text);
		box.dispatchEvent(new Event("input", { bubbles: true }));
	});
	await page.click(q("button.composer-send"));
	await settle(30);
	return box;
}

test("on a phone a message sent from the table closes the keyboard; on a wide screen the box keeps the focus for the next one", async () => {
	load([...everyone, group("crew", ["guide", "scout"])]);
	phone = true;
	await show();
	let box = await sendFromBox("hello council");
	expect(said).toContainEqual({
		room: "app:group.crew",
		text: "hello council",
	});
	expect(document.activeElement).not.toBe(box);
	phone = false;
	await page.render(null);
	await show();
	box = await sendFromBox("and again");
	expect(said.at(-1)?.text).toBe("and again");
	expect(document.activeElement).toBe(box);
});

test("the same send in chat mode closes a phone's keyboard too", async () => {
	load([...everyone, group("crew", ["guide", "scout"])]);
	phone = true;
	await show();
	await page.click(
		all<HTMLInputElement>('.table-mode input[type="radio"]').find(
			(radio) => radio.value === "chat",
		) ?? null,
	);
	await settle();
	const box = await sendFromBox("from the chat");
	expect(said.at(-1)).toEqual({
		room: "app:group.crew",
		text: "from the chat",
	});
	expect(document.activeElement).not.toBe(box);
});

test("the table page switches between the scene and a chat of the council, keeps the choice on the device, and the chat shows the messages and the cards", async () => {
	load([...everyone, group("crew", ["guide", "scout"])]);
	messages.mockResolvedValue({
		messages: [
			{
				id: 4,
				room: "app:group.crew",
				kind: "agent",
				agent: "scout",
				author: "scout",
				text: "Three leads found.",
				files: [],
				at: "2026-10-31T10:00:00.000Z",
			},
		],
		more: false,
		cards: [],
	});
	await show();
	const radios = () => all<HTMLInputElement>('.table-mode input[type="radio"]');
	const legend = q(".table-mode legend");
	expect(legend?.textContent).toBe("Show the council as");
	expect(radios().map((radio) => radio.closest("label")?.textContent)).toEqual([
		"Animation mode",
		"Chat mode",
	]);
	// The scene by default: the seats and the dialogue box, no chat.
	expect(radios()[0]?.checked).toBe(true);
	expect(all("g.seat").length).toBeGreaterThan(0);
	expect(q(".scene-box")).not.toBeNull();
	expect(q(".table-chat")).toBeNull();
	// A draft typed in the scene's box stays for the chat's.
	await page.act(() => {
		const box = q<HTMLTextAreaElement>(".scene-box textarea");
		Object.getOwnPropertyDescriptor(
			HTMLTextAreaElement.prototype,
			"value",
		)?.set?.call(box, "half a thought");
		box?.dispatchEvent(new Event("input", { bubbles: true }));
	});
	await page.click(radios()[1] ?? null);
	await settle();
	expect(radios()[1]?.checked).toBe(true);
	expect(radios()[1]?.closest("label")?.getAttribute("data-checked")).toBe(
		"true",
	);
	expect(q(".scene-box")).toBeNull();
	expect(all("g.seat")).toHaveLength(0);
	const chat = q(".table-chat");
	expect(chat?.textContent).toContain("Three leads found.");
	expect(chat?.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe(
		"half a thought",
	);
	expect(localStorage.getItem(TABLE_MODE_KEY)).toBe("chat");
	// A card that waits shows in the chat as it does in a room.
	await page.act(() => {
		store.dispatch({
			type: "prompt",
			room: "app:group.crew",
			prompt: {
				id: "p9",
				kind: "approval",
				title: "Ship the release?",
				message: "Ship it.",
				purpose: "action",
			},
		});
	});
	await settle(30);
	expect(q(".table-chat")?.textContent).toContain("Ship the release?");
	// A page that comes back to the table finds the chat.
	resetTableView();
	await page.render(null);
	await show();
	expect(q(".table-chat")).not.toBeNull();
	expect(q(".scene-box")).toBeNull();
	// And the card waits in the scene's box too.
	await page.click(radios()[0] ?? null);
	await settle();
	expect(q(".table-chat")).toBeNull();
	expect(q(".scene-box")?.textContent).toContain("Ship the release?");
	expect(localStorage.getItem(TABLE_MODE_KEY)).toBe("scene");
});

test("a table with no council has no mode switch", async () => {
	load(everyone);
	await show();
	expect(q(".table-mode")).toBeNull();
});
