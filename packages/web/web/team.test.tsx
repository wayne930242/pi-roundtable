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
	AgentProfileView,
	ArchivedEntry,
	ConfigView,
	GroupProfileView,
	RoomView,
} from "../src/api-types.ts";
import { ActionMenuHost } from "./components/action-menu.tsx";
import { RoomConfirmHost } from "./components/room-confirms.tsx";
import { TeamSheetHost } from "./components/team-sheets.tsx";
import { Toaster } from "./components/toaster.tsx";
import { openPage, releaseDom, type TestPage } from "./dom.ts";
import { closeMenu } from "./lib/action-menu.ts";
import { api } from "./lib/api.ts";
import { store } from "./lib/app-store.ts";
import { ConfigContext } from "./lib/config.ts";
import { loadKit } from "./lib/kit.ts";
import { clearRoomConfirm } from "./lib/room-confirm.ts";
import { setRouting } from "./lib/router.ts";
import { type AppConnection, setConnection } from "./lib/socket.ts";
import { teamApi } from "./lib/team-api.ts";
import {
	closeTeamSheet,
	currentTeamSheet,
	openTeamSheet,
} from "./lib/team-sheet.ts";
import { RoomsPage } from "./pages/rooms.tsx";

const SCOUT = "app:agent.scout";
const INFRA = "app:agent.infra";
const BOSS = "app:agent.boss";
const TEAM = "app:group.team";

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

const profile = (name: string): AgentProfileView => ({
	name,
	displayName: name,
	prompt: "p",
	effective: { model: "m", thinking: "medium" },
	avatar: "avatars/x.png",
	character: {
		v: 1,
		class: "scribe",
		outfit: "robe",
		hat: "none",
		prop: "none",
		hair: "short",
		beard: "none",
		accessory: "none",
		build: "regular",
		skin: 1,
		hairColor: "#3b2a1a",
		colors: { primary: "#112233", secondary: "#445566", trim: "#778899" },
	} as never,
	room: `app:agent.${name}`,
});

let page: TestPage;
beforeAll(async () => {
	await loadKit();
	// The new-agent sheet loads the creator on demand; having it loaded keeps the tests off the clock.
	await import("./components/character-creator.tsx");
	page = await openPage();
	setRouting(undefined);
	setConnection(partial<AppConnection>({ send: () => true }));
});
afterAll(async () => {
	setConnection(undefined);
	await page.unmount();
	await releaseDom();
});

const settle = (ms = 40) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));
const q = <T extends Element = HTMLElement>(selector: string): T | null =>
	document.querySelector<T>(selector);
const all = <T extends Element = HTMLElement>(selector: string): T[] => [
	...document.querySelectorAll<T>(selector),
];
const typeInto = (
	element: HTMLTextAreaElement | HTMLInputElement | null,
	text: string,
) => {
	if (!element) throw new Error("nothing to type into");
	return page.act(() => {
		const prototype =
			element instanceof HTMLTextAreaElement
				? HTMLTextAreaElement.prototype
				: HTMLInputElement.prototype;
		Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
			element,
			text,
		);
		element.dispatchEvent(new Event("input", { bubbles: true }));
	});
};
const button = (text: string, within: ParentNode = document) =>
	[...within.querySelectorAll<HTMLButtonElement>("button")].find(
		(one) => one.textContent?.trim() === text,
	) ?? null;
const field = (label: string) =>
	all<HTMLLabelElement>("label")
		.find((one) => one.firstChild?.textContent === label)
		?.querySelector<HTMLInputElement | HTMLTextAreaElement>(
			"input, textarea",
		) ?? null;
const chip = (text: string) =>
	all<HTMLButtonElement>("button.option-chip").find(
		(one) => one.textContent === text,
	) ?? null;
const menuItems = (): HTMLElement[] => all('[role^="menuitem"]');
const dialog = (title: string) =>
	all<HTMLDialogElement>("dialog.sheet").find(
		(one) => one.getAttribute("aria-label") === title,
	);

let models: ReturnType<typeof spyOn>;
let rooms: ReturnType<typeof spyOn>;
beforeEach(() => {
	window.innerWidth = 1280;
	window.location.hash = "#/rooms";
	const listed = [
		view(BOSS, { home: true }),
		view(SCOUT),
		view(INFRA),
		view(TEAM, { kind: "group", members: ["scout", "infra"] }),
	];
	store.dispatch({ type: "rooms_loaded", rooms: listed });
	models = spyOn(api, "models").mockResolvedValue({
		models: ["model-a", "model-b"],
	});
	rooms = spyOn(api, "rooms").mockResolvedValue({ rooms: listed });
});
afterEach(async () => {
	await page.act(() => closeMenu());
	closeTeamSheet();
	clearRoomConfirm();
	await page.render(null);
	store.dispatch({ type: "rooms_loaded", rooms: [] });
	models.mockRestore();
	rooms.mockRestore();
});

const Host = () => (
	<ConfigContext.Provider value={config}>
		<RoomsPage onSearch={() => undefined} />
		<ActionMenuHost />
		<TeamSheetHost />
		<RoomConfirmHost />
		<Toaster />
	</ConfigContext.Provider>
);

async function openSheet(ask: Parameters<typeof openTeamSheet>[0]) {
	await page.render(<Host />);
	await page.act(() => openTeamSheet(ask));
	await page.act(() => settle(60));
}

// ── The + menu ───────────────────────────────────────────────────────────────────────────────

test("the + button of the room list offers a new agent, a new group and the archive, and each opens its sheet", async () => {
	await page.render(<Host />);
	const add = q<HTMLButtonElement>('button[aria-label="Add"]');
	expect(add).not.toBeNull();
	await page.click(add);
	await page.act(() => settle(60));
	expect(menuItems().map((one) => one.textContent)).toEqual([
		"New agent",
		"New group",
		"Archived",
	]);
	await page.click(
		menuItems().find((one) => one.textContent === "New group") ?? null,
	);
	await page.act(() => settle(80));
	expect(currentTeamSheet()).toMatchObject({ kind: "group" });
	expect(
		currentTeamSheet()?.kind === "group" &&
			"name" in (currentTeamSheet() ?? {}),
	).toBe(false);
	expect(dialog("New group")?.open).toBe(true);
});

// ── A new agent ──────────────────────────────────────────────────────────────────────────────

test("a new agent needs a name, a valid permanent name and a prompt, and the permanent name follows the name until it is typed", async () => {
	await openSheet({ kind: "new-agent" });
	expect(dialog("New agent")?.open).toBe(true);
	const submit = () => button("Make agent");
	expect(submit()?.disabled).toBe(true);
	await typeInto(field("Name"), "Notes Taker");
	expect(field("Permanent name")?.value).toBe("notes-taker");
	await typeInto(field("Prompt"), "Keep notes.");
	expect(submit()?.disabled).toBe(false);
	await typeInto(field("Permanent name"), "Notes Taker");
	expect(field("Permanent name")?.getAttribute("aria-invalid")).toBe("true");
	expect(submit()?.disabled).toBe(true);
	// Once typed by hand, the permanent name stays when the name changes.
	await typeInto(field("Permanent name"), "scribe");
	await typeInto(field("Name"), "Another");
	expect(field("Permanent name")?.value).toBe("scribe");
});

test("making an agent sends the form, shows its room and closes the sheet", async () => {
	const create = spyOn(teamApi, "createAgent").mockResolvedValue(
		profile("notes-taker"),
	);
	try {
		await openSheet({ kind: "new-agent" });
		await typeInto(field("Name"), "Notes Taker");
		await typeInto(field("Prompt"), "Keep notes.");
		await typeInto(field("Opening task"), "  Say hi.  ");
		await page.click(chip("model-b"));
		expect(models).toHaveBeenCalled();
		await page.click(button("Make agent"));
		await page.act(() => settle(60));
		expect(create).toHaveBeenCalledWith({
			name: "notes-taker",
			displayName: "Notes Taker",
			prompt: "Keep notes.",
			model: "model-b",
			task: "Say hi.",
		});
		expect(rooms).toHaveBeenCalled();
		expect(window.location.hash).toBe("#/room/app%3Aagent.notes-taker");
		expect(currentTeamSheet()).toBeUndefined();
		expect(document.body.textContent).toContain("Made notes-taker.");
	} finally {
		create.mockRestore();
	}
});

test("a look chosen in the creator is sent with the agent; leaving the creator keeps the suggestion", async () => {
	const create = spyOn(teamApi, "createAgent").mockResolvedValue(
		profile("notes"),
	);
	try {
		await openSheet({ kind: "new-agent" });
		await typeInto(field("Name"), "Notes");
		await typeInto(field("Prompt"), "Keep notes.");
		expect(document.body.textContent).toContain("Suggested from its role");
		await page.click(button("Choose a look"));
		await page.act(() => settle(120));
		expect(q(".agent-sheet .creator")).not.toBeNull();
		// Cancel returns to the form with nothing chosen.
		await page.click(q('button[data-action="cancel"]'));
		expect(q(".agent-sheet .creator")).toBeNull();
		expect(document.body.textContent).toContain("Suggested from its role");
		// Pick another class and use it.
		await page.click(button("Choose a look"));
		await page.act(() => settle(120));
		await page.click(q('button[data-class="knight"]'));
		await page.click(q('button[data-action="save"]'));
		await page.act(() => settle(40));
		expect(q(".agent-sheet .creator")).toBeNull();
		expect(document.body.textContent).toContain("Your look");
		await page.click(button("Make agent"));
		await page.act(() => settle(60));
		const body = create.mock.calls[0]?.[0];
		expect(body?.character).toMatchObject({ class: "knight" });
	} finally {
		create.mockRestore();
	}
});

test("a refusal of the server is shown in the sheet, which stays open with what was typed", async () => {
	const create = spyOn(teamApi, "createAgent").mockRejectedValue(
		new Error('The name "scout" is taken.'),
	);
	try {
		await openSheet({ kind: "new-agent" });
		await typeInto(field("Name"), "Scout");
		await typeInto(field("Prompt"), "Scout around.");
		await page.click(button("Make agent"));
		await page.act(() => settle(60));
		expect(q(".agent-sheet .failure")?.textContent).toContain("is taken");
		expect(dialog("New agent")?.open).toBe(true);
		expect(field("Prompt")?.value).toBe("Scout around.");
		expect(button("Make agent")?.disabled).toBe(false);
		expect(window.location.hash).toBe("#/rooms");
	} finally {
		create.mockRestore();
	}
});

// ── Groups ───────────────────────────────────────────────────────────────────────────────────

test("a new group needs 2 to 6 members; the host is one of them, and the group opens in its room", async () => {
	const create = spyOn(teamApi, "createGroup").mockResolvedValue({
		name: "duo",
		displayName: "Duo",
		members: ["scout", "infra"],
		host: "infra",
		room: "app:group.duo",
	} satisfies GroupProfileView);
	try {
		await openSheet({ kind: "group" });
		expect(dialog("New group")?.open).toBe(true);
		await typeInto(field("Name"), "Duo");
		expect(field("Permanent name")?.value).toBe("duo");
		const boxes = all<HTMLInputElement>('.agent-sheet input[type="checkbox"]');
		// The team's agents, home included.
		expect(boxes).toHaveLength(3);
		const submit = () => button("Make group");
		await page.click(boxes[1] ?? null);
		expect(submit()?.disabled).toBe(true);
		await page.click(boxes[2] ?? null);
		expect(submit()?.disabled).toBe(false);
		// The first picked is the host until another is chosen.
		expect(chip("scout")?.getAttribute("aria-pressed")).toBe("true");
		await page.click(chip("infra"));
		await page.click(submit());
		await page.act(() => settle(60));
		expect(create).toHaveBeenCalledWith({
			name: "duo",
			displayName: "Duo",
			members: ["scout", "infra"],
			host: "infra",
		});
		expect(window.location.hash).toBe("#/room/app%3Agroup.duo");
		expect(currentTeamSheet()).toBeUndefined();
	} finally {
		create.mockRestore();
	}
});

test("at six members the other agents cannot be added", async () => {
	const names = ["a1", "a2", "a3", "a4", "a5", "a6", "a7"];
	store.dispatch({
		type: "rooms_loaded",
		rooms: names.map((name) => view(`app:agent.${name}`)),
	});
	await openSheet({ kind: "group" });
	const boxes = all<HTMLInputElement>('.agent-sheet input[type="checkbox"]');
	for (const box of boxes.slice(0, 6)) await page.click(box);
	expect(boxes[6]?.disabled).toBe(true);
	await page.click(boxes[0] ?? null);
	expect(boxes[6]?.disabled).toBe(false);
});

test("editing a group renames it, changes its members and its host, and sends only what changed", async () => {
	const group = spyOn(teamApi, "group").mockResolvedValue({
		name: "team",
		displayName: "Team",
		members: ["scout", "infra"],
		host: "scout",
		room: TEAM,
	});
	const update = spyOn(teamApi, "updateGroup").mockImplementation(
		async (name, patch) => ({
			name,
			displayName: patch.displayName ?? "Team",
			members: patch.members ?? ["scout", "infra"],
			host: patch.host ?? "scout",
			room: TEAM,
		}),
	);
	try {
		await openSheet({ kind: "group", name: "team" });
		expect(dialog("Edit group")?.open).toBe(true);
		expect(group).toHaveBeenCalledWith("team");
		expect(field("Name")?.value).toBe("Team");
		// The permanent name is not offered for a group that exists.
		expect(field("Permanent name")).toBeNull();
		expect(button("Save")?.disabled).toBe(true);
		await typeInto(field("Name"), "Crew");
		expect(button("Save")?.disabled).toBe(false);
		await page.click(button("Save"));
		await page.act(() => settle(60));
		expect(update).toHaveBeenCalledWith("team", { displayName: "Crew" });
		expect(currentTeamSheet()).toBeUndefined();

		// Members and host.
		await openSheet({ kind: "group", name: "team" });
		const boxes = all<HTMLInputElement>('.agent-sheet input[type="checkbox"]');
		await page.click(boxes[0] ?? null);
		await page.click(chip("infra"));
		await page.click(button("Save"));
		await page.act(() => settle(60));
		expect(update).toHaveBeenLastCalledWith("team", {
			members: ["scout", "infra", "boss"],
			host: "infra",
		});
	} finally {
		group.mockRestore();
		update.mockRestore();
	}
});

test("a member taken out leaves fewer than two, so a group cannot be saved so", async () => {
	const group = spyOn(teamApi, "group").mockResolvedValue({
		name: "team",
		displayName: "Team",
		members: ["scout", "infra"],
		host: "scout",
		room: TEAM,
	});
	try {
		await openSheet({ kind: "group", name: "team" });
		const boxes = all<HTMLInputElement>('.agent-sheet input[type="checkbox"]');
		await page.click(boxes[1] ?? null);
		expect(button("Save")?.disabled).toBe(true);
	} finally {
		group.mockRestore();
	}
});

test("the group's sheet archives it after a question that names it", async () => {
	const group = spyOn(teamApi, "group").mockResolvedValue({
		name: "team",
		displayName: "Team",
		members: ["scout", "infra"],
		host: "scout",
		room: TEAM,
	});
	const archive = spyOn(teamApi, "archiveGroup").mockResolvedValue({
		ok: true,
	});
	try {
		await openSheet({ kind: "group", name: "team" });
		await page.click(button("Archive group"));
		await page.act(() => settle(60));
		const asking = dialog("Archive Team?");
		expect(asking?.open).toBe(true);
		expect(archive).not.toHaveBeenCalled();
		await page.click(button("Archive", asking));
		await page.act(() => settle(60));
		expect(archive).toHaveBeenCalledWith("team");
	} finally {
		group.mockRestore();
		archive.mockRestore();
	}
});

// ── Archive ──────────────────────────────────────────────────────────────────────────────────

test("a room row's Archive agent asks first, then archives and leaves the room", async () => {
	const archive = spyOn(teamApi, "archiveAgent").mockResolvedValue({
		ok: true,
	});
	try {
		window.location.hash = "#/room/app%3Aagent.scout";
		await page.render(<Host />);
		const row = all(".room-row").find((one) =>
			one.textContent?.includes("scout"),
		);
		await page.act(async () => {
			row?.dispatchEvent(
				new MouseEvent("contextmenu", {
					bubbles: true,
					cancelable: true,
					clientX: 10,
					clientY: 10,
				}),
			);
			await settle(40);
		});
		await page.click(
			menuItems().find((one) => one.textContent === "Archive agent") ?? null,
		);
		await page.act(() => settle(80));
		const asking = dialog("Archive scout?");
		expect(asking?.open).toBe(true);
		expect(asking?.textContent).toContain("scout stops answering");
		expect(archive).not.toHaveBeenCalled();
		await page.click(button("Archive", asking));
		await page.act(() => settle(60));
		expect(archive).toHaveBeenCalledWith("scout");
		expect(window.location.hash).toBe("#/rooms");
		expect(document.body.textContent).toContain("Archived scout.");
	} finally {
		archive.mockRestore();
	}
});

test("the coordinator's row has no Archive item", async () => {
	await page.render(<Host />);
	const row = all(".room-row").find((one) => one.textContent?.includes("boss"));
	await page.act(async () => {
		row?.dispatchEvent(
			new MouseEvent("contextmenu", {
				bubbles: true,
				cancelable: true,
				clientX: 10,
				clientY: 10,
			}),
		);
		await settle(40);
	});
	expect(menuItems().length).toBeGreaterThan(0);
	expect(menuItems().map((one) => one.textContent)).not.toContain(
		"Archive agent",
	);
});

const entries: ArchivedEntry[] = [
	{
		kind: "agent",
		name: "old",
		displayName: "Old Hand",
		avatar: "avatars/o.png",
	},
	{ kind: "group", name: "past", displayName: "Past", members: ["scout"] },
];

test("the archive lists what was archived; Restore puts it back, Delete asks first and names it", async () => {
	let listed = [...entries];
	const archive = spyOn(teamApi, "archive").mockImplementation(async () => ({
		entries: listed,
	}));
	const restore = spyOn(teamApi, "restoreAgent").mockImplementation(
		async () => {
			listed = listed.filter((one) => one.name !== "old");
			return profile("old");
		},
	);
	const remove = spyOn(teamApi, "deleteGroup").mockImplementation(async () => {
		listed = listed.filter((one) => one.name !== "past");
		return { ok: true };
	});
	try {
		await openSheet({ kind: "archive" });
		expect(dialog("Archived")?.open).toBe(true);
		const text = q(".agent-sheet")?.textContent ?? "";
		expect(text).toContain("Old Hand");
		expect(text).toContain("Past");
		const sheet = q<HTMLElement>(".agent-sheet");
		// Restore the agent.
		const rowOld = all("li.menu-item").find((one) =>
			one.textContent?.includes("Old Hand"),
		);
		await page.click(button("Restore", rowOld));
		await page.act(() => settle(60));
		expect(restore).toHaveBeenCalledWith("old");
		expect(rooms).toHaveBeenCalled();
		expect(sheet?.textContent).not.toContain("Old Hand");
		// Delete the group: the question names it, and nothing is deleted before the answer.
		const rowPast = all("li.menu-item").find((one) =>
			one.textContent?.includes("Past"),
		);
		await page.click(button("Delete", rowPast));
		await page.act(() => settle(60));
		const asking = dialog("Delete Past?");
		expect(asking?.open).toBe(true);
		expect(remove).not.toHaveBeenCalled();
		await page.click(button("Cancel", asking));
		await page.act(() => settle(300));
		expect(remove).not.toHaveBeenCalled();
		await page.click(button("Delete", rowPast));
		await page.act(() => settle(60));
		await page.click(button("Delete", dialog("Delete Past?")));
		await page.act(() => settle(60));
		expect(remove).toHaveBeenCalledWith("past");
		expect(q(".agent-sheet")?.textContent).toContain("Nothing is archived.");
	} finally {
		archive.mockRestore();
		restore.mockRestore();
		remove.mockRestore();
	}
});

test("a refused restore is told and the entry stays", async () => {
	const archive = spyOn(teamApi, "archive").mockResolvedValue({
		entries: [entries[1] as ArchivedEntry],
	});
	const restore = spyOn(teamApi, "restoreGroup").mockRejectedValue(
		new Error("A group has 2 to 6 different members."),
	);
	try {
		await openSheet({ kind: "archive" });
		await page.click(button("Restore"));
		await page.act(() => settle(60));
		expect(document.body.textContent).toContain(
			"A group has 2 to 6 different members.",
		);
		expect(q(".agent-sheet")?.textContent).toContain("Past");
	} finally {
		archive.mockRestore();
		restore.mockRestore();
	}
});
