import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	expect,
	spyOn,
	test,
} from "bun:test";
import { CATALOG, type CharacterSpec } from "pi-roundtable/characters";
import { partial } from "pi-roundtable/testing";
import type {
	AgentProfileView,
	AgentSkillsView,
	ConfigView,
	RoomView,
} from "../src/api-types.ts";
import { AgentSheetHost } from "./components/agent-sheet.tsx";
import { RoomConfirmHost } from "./components/room-confirms.tsx";
import { Toaster } from "./components/toaster.tsx";
import { openPage, releaseDom, type TestPage } from "./dom.ts";
import {
	closeAgentSheet,
	currentAgentSheet,
	openAgentSheet,
} from "./lib/agent-sheet.ts";
import { ApiFailure, api } from "./lib/api.ts";
import { store } from "./lib/app-store.ts";
import { ConfigContext } from "./lib/config.ts";
import { editApi } from "./lib/edit-api.ts";
import { loadKit } from "./lib/kit.ts";
import { clearRoomConfirm } from "./lib/room-confirm.ts";
import { setRouting } from "./lib/router.ts";
import { type AppConnection, setConnection } from "./lib/socket.ts";
import { teamApi } from "./lib/team-api.ts";
import { closeTeamSheet, currentTeamSheet } from "./lib/team-sheet.ts";
import { AgentPage } from "./pages/agent.tsx";
import { RoomPage } from "./pages/room.tsx";

const SCOUT = "app:agent.scout";
const config: ConfigView = {
	title: "Console",
	panes: ["rooms"],
	timeZone: "UTC",
	look: "modern",
};

const character: CharacterSpec = {
	v: 1,
	class: "knight",
	...CATALOG.classes.knight.preset,
};

const profile = (over: Partial<AgentProfileView> = {}): AgentProfileView => ({
	name: "scout",
	displayName: "Scout",
	prompt: "You scout.\nBe brief.\nNever guess.",
	effective: { model: "model-a", thinking: "medium" },
	avatar: "avatars/x.png",
	character,
	room: SCOUT,
	...over,
});

const view = (over: Partial<RoomView> = {}): RoomView => ({
	key: SCOUT,
	kind: "agent",
	name: "scout",
	displayName: "Scout",
	home: false,
	readOnly: false,
	mode: { yolo: false, longRunning: false },
	typing: false,
	stoppable: false,
	...over,
});

let page: TestPage;
beforeAll(async () => {
	await loadKit();
	// The sheet loads the creator on demand; having it loaded already keeps the tests off the clock.
	await import("./components/character-creator.tsx");
	page = await openPage();
	setRouting(undefined);
	setConnection(
		partial<AppConnection>({
			send: () => true,
			focus: () => undefined,
		}),
	);
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
const button = (text: string) =>
	all<HTMLButtonElement>("button").find(
		(one) => one.textContent?.trim() === text,
	) ?? null;
/** The form's own submit button; the character creator has a Save of its own. */
const submit = () =>
	q<HTMLButtonElement>(".agent-sheet > form button[type=submit]");
const inReview = (text: string) =>
	all<HTMLButtonElement>(".review button").find(
		(one) => one.textContent === text,
	) ?? null;
const chip = (text: string) =>
	all<HTMLButtonElement>("button.option-chip").find(
		(one) => one.textContent === text,
	) ?? null;

let agent: ReturnType<typeof spyOn>;
let models: ReturnType<typeof spyOn>;
let update: ReturnType<typeof spyOn>;
let skills: ReturnType<typeof spyOn>;
const skillList = (carried: string[] = []): AgentSkillsView => ({
	skills: [
		{
			name: "writing-skills",
			description: "Use when writing a skill.",
			source: "builtin",
			builtin: true,
			carried: true,
		},
		{
			name: "kit-do",
			description: "Use when changing source.",
			source: "linked",
			builtin: false,
			carried: carried.includes("kit-do"),
		},
	],
});
beforeEach(() => {
	window.innerWidth = 1280;
	window.location.hash = "#/room/app%3Aagent.scout";
	store.dispatch({ type: "rooms_loaded", rooms: [view()] });
	agent = spyOn(api, "agent").mockResolvedValue(profile());
	models = spyOn(api, "models").mockResolvedValue({
		models: ["model-a", "model-b"],
	});
	update = spyOn(api, "updateAgent").mockImplementation(async (_name, patch) =>
		profile(patch as Partial<AgentProfileView>),
	);
	skills = spyOn(teamApi, "skills").mockResolvedValue(skillList());
});
afterEach(async () => {
	closeAgentSheet();
	await page.render(null);
	store.dispatch({ type: "rooms_loaded", rooms: [] });
	agent.mockRestore();
	models.mockRestore();
	update.mockRestore();
	skills.mockRestore();
	clearRoomConfirm();
	closeTeamSheet();
});

const Host = () => (
	<ConfigContext.Provider value={config}>
		<AgentSheetHost />
		<RoomConfirmHost />
		<Toaster />
	</ConfigContext.Provider>
);

async function open(options: { look?: boolean; creator?: boolean } = {}) {
	await page.render(<Host />);
	await page.act(() =>
		openAgentSheet("scout", { look: options.look === true }),
	);
	// The profile arrives, then the creator's chunk; each wait ends in an `act`, which draws what came.
	for (let waited = 0; waited < 5000; waited += 40) {
		await page.act(() => settle(40));
		if (options.creator === false || q(".agent-sheet .creator")) return;
	}
}

test("the sheet is a wide sheet titled Edit agent, with the agent's fields, chips and look", async () => {
	await open();
	const dialog = q<HTMLDialogElement>("dialog.sheet");
	expect(dialog?.open).toBe(true);
	expect(dialog?.classList.contains("wide")).toBe(true);
	expect(q(".agent-sheet")).not.toBeNull();
	expect(dialog?.getAttribute("aria-label")).toBe("Edit agent");
	expect(agent).toHaveBeenCalledWith("scout");
	expect(q<HTMLInputElement>(".agent-sheet input")?.value).toBe("Scout");
	expect(q<HTMLTextAreaElement>(".agent-sheet textarea")?.value).toBe(
		"You scout.\nBe brief.\nNever guess.",
	);
	// Model and thinking are chips; the saved choice is the pressed one.
	expect(all("button.option-chip").map((one) => one.textContent)).toEqual([
		"Follow the assistant",
		"model-a",
		"model-b",
		"Follow the assistant (automatic)",
		"Off",
		"Minimal",
		"Low",
		"Medium",
		"High",
		"Very high",
	]);
	expect(chip("Follow the assistant")?.getAttribute("aria-pressed")).toBe(
		"true",
	);
	expect(chip("model-b")?.getAttribute("aria-pressed")).toBe("false");
	expect(q(".agent-sheet .creator")).not.toBeNull();
});

test("choosing a model saves just the model, with no review step", async () => {
	await open();
	expect(submit()?.disabled).toBe(true);
	await page.click(chip("model-b"));
	expect(chip("model-b")?.getAttribute("aria-pressed")).toBe("true");
	expect(chip("Follow the assistant")?.getAttribute("aria-pressed")).toBe(
		"false",
	);
	expect(submit()?.textContent).toBe("Save");
	await page.click(submit());
	expect(update).toHaveBeenCalledTimes(1);
	expect(update).toHaveBeenCalledWith("scout", { model: "model-b" });
	expect(document.body.textContent).toContain("Saved.");
});

test("a changed prompt is reviewed as a diff before it is saved", async () => {
	await open();
	await typeInto(
		q<HTMLTextAreaElement>(".agent-sheet textarea"),
		"You scout.\nBe thorough.\nNever guess.",
	);
	// The button says what comes next, and nothing is sent yet.
	expect(submit()?.textContent).toBe("Review changes");
	await page.click(submit());
	expect(update).not.toHaveBeenCalled();
	// The button that opened the review is gone: the keyboard continues from the review.
	expect(document.activeElement?.classList.contains("review")).toBe(true);
	const lines = all(".diff-line").map((one) => [
		one.getAttribute("data-kind"),
		one.textContent?.replace(/^[ +−]/, "").replace(/^(Added|Removed): /, ""),
	]);
	expect(lines).toEqual([
		["same", "You scout."],
		["del", "Be brief."],
		["add", "Be thorough."],
		["same", "Never guess."],
	]);
	expect(document.body.textContent).toContain("Lines: 1 added, 1 removed");

	// Back to the editor keeps the text.
	await page.click(inReview("Back to editing"));
	expect(q<HTMLTextAreaElement>(".agent-sheet textarea")?.value).toContain(
		"Be thorough.",
	);
	await page.click(submit());
	await page.click(inReview("Save"));
	expect(update).toHaveBeenCalledWith("scout", {
		prompt: "You scout.\nBe thorough.\nNever guess.",
	});
	// Saved: the form is back, clean.
	expect(q(".review")).toBeNull();
	expect(submit()?.disabled).toBe(true);
});

test("the review lists a changed name and model beside the prompt diff", async () => {
	await open();
	await typeInto(q<HTMLInputElement>(".agent-sheet input"), "Scout II");
	await page.click(chip("model-a"));
	await typeInto(q<HTMLTextAreaElement>(".agent-sheet textarea"), "New prompt");
	await page.click(submit());
	const fields = all(".review-fields li").map((one) => one.textContent);
	expect(fields).toEqual([
		"NameScout→Scout II",
		"ModelFollow the assistant→model-a",
	]);
	await page.click(inReview("Save"));
	expect(update).toHaveBeenCalledWith("scout", {
		displayName: "Scout II",
		prompt: "New prompt",
		model: "model-a",
	});
});

test("the prompt opens in a full-screen editor that edits the same text", async () => {
	await open();
	await page.click(button("Full screen"));
	await settle(40);
	const full = q<HTMLDialogElement>("dialog.sheet.full");
	expect(full?.open).toBe(true);
	expect(full?.getAttribute("aria-label")).toBe("Prompt");
	const area = full?.querySelector<HTMLTextAreaElement>("textarea.prompt-full");
	expect(area?.value).toBe("You scout.\nBe brief.\nNever guess.");
	await typeInto(area ?? null, "Typed in full screen");
	expect(q<HTMLTextAreaElement>(".agent-sheet > form textarea")?.value).toBe(
		"Typed in full screen",
	);
	await page.click(
		full?.querySelector<HTMLElement>(".sheet-head button") ?? null,
	);
	await page.act(() => settle(300));
	expect(q("dialog.sheet.full")?.hasAttribute("open")).toBe(false);
	// The agent sheet itself stays open under it.
	expect(q<HTMLDialogElement>("dialog.sheet.wide")?.open).toBe(true);
});

const AT = "2026-10-29T08:00:00.000Z";
const versions = (): Awaited<
	ReturnType<typeof editApi.agentPromptHistory>
> => ({
	versions: [
		{
			id: 2,
			action: "set",
			text: "You scout.\nBe thorough.\nNever guess.",
			previous: "You scout.\nBe brief.\nNever guess.",
			by: "doctor",
			at: AT,
		},
		{
			id: 1,
			action: "set",
			text: "You scout.\nBe brief.\nNever guess.",
			previous: "You scout.",
			by: "Riley",
			at: AT,
		},
	],
});

/** The history sheet loads when asked for; wait for it to draw what it was given. */
async function openHistory() {
	await page.click(button("History"));
	for (let waited = 0; waited < 3000; waited += 40) {
		await page.act(() => settle(40));
		if (
			q(".history .menu-item") ||
			q(".history .empty") ||
			q(".history .failure")
		)
			return;
	}
}

test("History lists who changed the prompt and when, shows a change as a diff, and takes its text into the editor to be reviewed and saved", async () => {
	const history = spyOn(editApi, "agentPromptHistory").mockResolvedValue(
		versions(),
	);
	try {
		await open();
		await openHistory();
		expect(history).toHaveBeenCalledWith("scout");
		expect(q("dialog.sheet.wide .history")).not.toBeNull();
		const rows = all(".history .menu-item").map((one) => one.textContent ?? "");
		expect(rows).toHaveLength(2);
		expect(rows[0]).toContain("doctor");
		expect(rows[1]).toContain("Riley");
		// Nothing is shown of a change until one is chosen.
		expect(q(".history .diff")).toBeNull();
		await page.click(all<HTMLButtonElement>(".history .menu-item")[1] ?? null);
		const lines = all(".history .diff-line").map((one) => [
			one.getAttribute("data-kind"),
			one.textContent?.replace(/^[ +−]/, "").replace(/^(Added|Removed): /, ""),
		]);
		// This change added two lines under the first.
		expect(lines).toEqual([
			["same", "You scout."],
			["add", "Be brief."],
			["add", "Never guess."],
		]);
		await page.click(button("Use this text"));
		// The text is in the editor as an edit to save; nothing was sent.
		expect(q<HTMLTextAreaElement>(".agent-sheet > form textarea")?.value).toBe(
			"You scout.\nBe brief.\nNever guess.",
		);
		expect(q(".history")).toBeNull();
		expect(update).not.toHaveBeenCalled();
	} finally {
		history.mockRestore();
	}
});

test("a version taken from the history is saved through the same diff review as any edit", async () => {
	const history = spyOn(editApi, "agentPromptHistory").mockResolvedValue(
		versions(),
	);
	try {
		agent.mockResolvedValue(
			profile({ prompt: "You scout.\nBe thorough.\nNever guess." }),
		);
		await open();
		await openHistory();
		await page.click(all<HTMLButtonElement>(".history .menu-item")[1] ?? null);
		await page.click(button("Use this text"));
		expect(submit()?.textContent).toBe("Review changes");
		await page.click(submit());
		expect(update).not.toHaveBeenCalled();
		await page.click(inReview("Save"));
		expect(update).toHaveBeenCalledWith("scout", {
			prompt: "You scout.\nBe brief.\nNever guess.",
		});
	} finally {
		history.mockRestore();
	}
});

test("History says so when no change was kept, and shows a failure to read it", async () => {
	const history = spyOn(editApi, "agentPromptHistory").mockResolvedValue({
		versions: [],
	});
	try {
		await open();
		await openHistory();
		expect(q(".history .empty")?.textContent).toBe(
			"No changes have been kept yet.",
		);
		history.mockRejectedValue(new Error("history is down"));
		await page.act(() => {
			document
				.querySelector<HTMLElement>("dialog.sheet.wide .history")
				?.closest("dialog")
				?.dispatchEvent(
					new Event("cancel", { bubbles: true, cancelable: true }),
				);
		});
		await page.act(() => settle(300));
		await openHistory();
		expect(q(".history .failure")?.textContent).toBe("history is down");
	} finally {
		history.mockRestore();
	}
});

test("Escape in the full-screen editor closes only the editor", async () => {
	await open();
	await page.click(button("Full screen"));
	const full = q<HTMLDialogElement>("dialog.sheet.full");
	await page.act(() => {
		full?.dispatchEvent(
			new Event("cancel", { bubbles: true, cancelable: true }),
		);
	});
	await page.act(() => settle(300));
	expect(q("dialog.sheet.full")?.hasAttribute("open")).toBe(false);
	expect(q<HTMLDialogElement>("dialog.sheet.wide")?.open).toBe(true);
});

test("the notifications switch mutes the room for every owner and shows the bell-slash", async () => {
	const setMute = spyOn(api, "setMute").mockResolvedValue({ muted: true });
	try {
		await open();
		const toggle = q<HTMLButtonElement>(".agent-sheet [role=switch]");
		expect(toggle?.getAttribute("aria-checked")).toBe("true");
		await page.click(toggle);
		await settle(20);
		expect(setMute).toHaveBeenCalledWith(SCOUT, true);
		expect(q(".agent-sheet [role=switch]")?.getAttribute("aria-checked")).toBe(
			"false",
		);
		expect(store.getState().rooms[SCOUT]?.view?.muted).toBe(true);
	} finally {
		setMute.mockRestore();
	}
});

test("Change look opens the sheet scrolled to the creator", async () => {
	const scrolled: Element[] = [];
	const original = Element.prototype.scrollIntoView;
	Element.prototype.scrollIntoView = function (this: Element) {
		scrolled.push(this);
	};
	try {
		await open({ look: true });
		expect(scrolled).toHaveLength(1);
		expect(scrolled[0]?.querySelector(".creator")).not.toBeNull();
		expect(document.activeElement).toBe(scrolled[0] ?? null);
	} finally {
		Element.prototype.scrollIntoView = original;
	}
});

test("Change look after Edit agent for the same agent scrolls to the creator", async () => {
	const scrolled: Element[] = [];
	const original = Element.prototype.scrollIntoView;
	Element.prototype.scrollIntoView = function (this: Element) {
		scrolled.push(this);
	};
	try {
		await open();
		expect(scrolled).toHaveLength(0);
		await page.act(() => openAgentSheet("scout", { look: true }));
		await page.act(() => settle(80));
		expect(scrolled).toHaveLength(1);
		expect(scrolled[0]?.querySelector(".creator")).not.toBeNull();
	} finally {
		Element.prototype.scrollIntoView = original;
	}
});

test("opening the sheet again for the same agent reads the profile again, and keeps an unsaved draft", async () => {
	await open();
	expect(agent).toHaveBeenCalledTimes(1);
	agent.mockResolvedValue(profile({ displayName: "Scout Prime" }));
	await page.act(() => openAgentSheet("scout"));
	await page.act(() => settle(80));
	expect(agent).toHaveBeenCalledTimes(2);
	expect(q<HTMLInputElement>(".agent-sheet input")?.value).toBe("Scout Prime");
	// An edit that is not saved survives the next ask.
	await typeInto(q<HTMLInputElement>(".agent-sheet input"), "Scout Two");
	agent.mockResolvedValue(profile({ displayName: "Scout Third" }));
	await page.act(() => openAgentSheet("scout"));
	await page.act(() => settle(80));
	expect(agent).toHaveBeenCalledTimes(3);
	expect(q<HTMLInputElement>(".agent-sheet input")?.value).toBe("Scout Two");
});

test("the system Back takes the sheet away with the page it was opened on", async () => {
	await open();
	expect(q<HTMLDialogElement>("dialog.sheet.wide")?.open).toBe(true);
	// A hash that stays where it was moves nothing.
	await page.act(() => {
		window.dispatchEvent(new PopStateEvent("popstate"));
	});
	expect(q<HTMLDialogElement>("dialog.sheet.wide")?.open).toBe(true);
	await page.act(() => {
		window.location.hash = "#/rooms";
	});
	// The browser reports the new address a moment later.
	for (let waited = 0; waited < 3000 && currentAgentSheet(); waited += 50)
		await page.act(() => settle(50));
	await page.act(() => settle(300));
	expect(q<HTMLDialogElement>("dialog.sheet.wide")?.open).toBe(false);
	expect(currentAgentSheet()).toBeUndefined();
});

test("a profile that cannot be read says so", async () => {
	agent.mockRejectedValue(new Error("There is no such room, agent or file."));
	await open({ creator: false });
	expect(q("dialog.sheet")?.textContent).toContain(
		"There is no such room, agent or file.",
	);
});

// ── The old page ─────────────────────────────────────────────────────────────────────────────

test("#/agent/<name> stands in for the agent's room, with the sheet open and no extra history entry", async () => {
	window.location.hash = "#/rooms";
	const before = window.history.length;
	window.location.hash = "#/agent/scout";
	const afterLink = window.history.length;
	await page.render(
		<>
			<AgentPage name="scout" />
			<Host />
		</>,
	);
	await page.act(() => settle(120));
	expect(window.location.hash).toBe(`#/room/${encodeURIComponent(SCOUT)}`);
	// The link's own entry was replaced, not added to.
	expect(window.history.length).toBe(afterLink);
	expect(afterLink).toBe(before + 1);
	expect(q<HTMLDialogElement>("dialog.sheet")?.open).toBe(true);
	expect(q<HTMLInputElement>(".agent-sheet input")?.value).toBe("Scout");
});

test("#/agent/<name> for an agent that is not listed goes to the room list", async () => {
	store.dispatch({ type: "rooms_loaded", rooms: [] });
	window.location.hash = "#/agent/ghost";
	await page.render(<AgentPage name="ghost" />);
	await page.act(() => settle(60));
	expect(window.location.hash).toBe("#/rooms");
});

// ── The room's header ────────────────────────────────────────────────────────────────────────

const Room = () => (
	<ConfigContext.Provider value={config}>
		<RoomPage roomKey={SCOUT} />
		<AgentSheetHost />
	</ConfigContext.Provider>
);

test("the header's name opens the sheet while the picture stays the drawer's button", async () => {
	const messages = spyOn(api, "messages").mockResolvedValue({
		messages: [],
		more: false,
		cards: [],
	});
	try {
		window.innerWidth = 390;
		await page.render(<Room />);
		await page.act(() => settle(60));
		const name = q<HTMLButtonElement>("button.room-name");
		expect(name?.textContent).toBe("Scout");
		expect(name?.getAttribute("aria-haspopup")).toBe("dialog");
		// The picture is the switcher's: it never opens the sheet.
		expect(q("button.room-picture")?.getAttribute("aria-label")).toBe(
			"Switch rooms",
		);
		await page.click(name);
		await page.act(() => settle(80));
		expect(q<HTMLDialogElement>("dialog.sheet.wide")?.open).toBe(true);
		expect(q(".room-muted")).toBeNull();
	} finally {
		messages.mockRestore();
	}
});

test("a muted room shows the bell-slash in its header, and the room menu has the switch", async () => {
	const messages = spyOn(api, "messages").mockResolvedValue({
		messages: [],
		more: false,
		cards: [],
	});
	const setMute = spyOn(api, "setMute").mockResolvedValue({ muted: false });
	try {
		store.dispatch({ type: "rooms_loaded", rooms: [view({ muted: true })] });
		await page.render(<Room />);
		await page.act(() => settle(60));
		expect(q(".room-muted")?.getAttribute("aria-label")).toBe(
			"Notifications are off",
		);
		await page.click(q('button[aria-label="Room menu"]'));
		// The menu's code loads when it is first opened.
		for (let waited = 0; waited < 3000 && !q("#room-menu-mute"); waited += 40)
			await page.act(() => settle(40));
		const toggle = q<HTMLButtonElement>("#room-menu-mute");
		expect(toggle?.getAttribute("aria-checked")).toBe("false");
		await page.click(toggle);
		await page.act(() => settle(20));
		expect(setMute).toHaveBeenCalledWith(SCOUT, false);
		expect(q(".room-muted")).toBeNull();
	} finally {
		messages.mockRestore();
		setMute.mockRestore();
	}
});

test("a group's header name is a button that opens the group's sheet, not an agent's", async () => {
	const messages = spyOn(api, "messages").mockResolvedValue({
		messages: [],
		more: false,
		cards: [],
	});
	try {
		store.dispatch({
			type: "rooms_loaded",
			rooms: [
				view({
					key: "app:group.team",
					kind: "group",
					name: "team",
					displayName: "Team",
					members: ["scout"],
				}),
			],
		});
		await page.render(
			<ConfigContext.Provider value={config}>
				<RoomPage roomKey="app:group.team" />
			</ConfigContext.Provider>,
		);
		await page.act(() => settle(60));
		const name = q<HTMLButtonElement>("button.room-name");
		expect(name?.textContent).toBe("Team");
		expect(name?.title).toBe("Edit group");
		await page.click(name);
		expect(currentTeamSheet()).toMatchObject({ kind: "group", name: "team" });
		expect(currentAgentSheet()).toBeUndefined();
	} finally {
		messages.mockRestore();
	}
});

test("the sheet lists the host's skills; the built-in one is on and cannot be turned off, another flips as the server says", async () => {
	const set = spyOn(teamApi, "setSkills").mockResolvedValue(
		skillList(["kit-do"]),
	);
	try {
		await open();
		expect(skills).toHaveBeenCalledWith("scout");
		const switches = all<HTMLButtonElement>(
			'section[aria-label="Skills"] button[role=switch]',
		);
		expect(switches.map((one) => one.getAttribute("aria-label"))).toEqual([
			"writing-skills",
			"kit-do",
		]);
		expect(switches[0]?.disabled).toBe(true);
		expect(switches[0]?.getAttribute("aria-checked")).toBe("true");
		expect(switches[1]?.getAttribute("aria-checked")).toBe("false");
		await page.click(switches[1] ?? null);
		await page.act(() => settle(40));
		expect(set).toHaveBeenCalledWith("scout", { add: ["kit-do"] });
		expect(
			q(
				'section[aria-label="Skills"] button[aria-label="kit-do"]',
			)?.getAttribute("aria-checked"),
		).toBe("true");
		// Flipping it back asks for the removal.
		set.mockResolvedValue(skillList());
		await page.click(
			q('section[aria-label="Skills"] button[aria-label="kit-do"]'),
		);
		await page.act(() => settle(40));
		expect(set).toHaveBeenLastCalledWith("scout", { remove: ["kit-do"] });
	} finally {
		set.mockRestore();
	}
});

test("a refused skill change shows the server's words and leaves the switch where it was", async () => {
	const set = spyOn(teamApi, "setSkills").mockRejectedValue(
		new Error("Unknown skills: kit-do."),
	);
	try {
		await open();
		await page.click(
			q('section[aria-label="Skills"] button[aria-label="kit-do"]'),
		);
		await page.act(() => settle(40));
		expect(document.body.textContent).toContain("Unknown skills: kit-do.");
		expect(
			q(
				'section[aria-label="Skills"] button[aria-label="kit-do"]',
			)?.getAttribute("aria-checked"),
		).toBe("false");
	} finally {
		set.mockRestore();
	}
});

test("a host without skills shows no skills section", async () => {
	skills.mockRejectedValue(
		new ApiFailure("This host has no skills.", undefined, 404),
	);
	await open();
	expect(q('section[aria-label="Skills"]')).toBeNull();
	expect(q(".agent-sheet .failure")).toBeNull();
});

test("Archive asks first, naming the agent, and archives it through the server", async () => {
	const archive = spyOn(teamApi, "archiveAgent").mockResolvedValue({
		ok: true,
	});
	const rooms = spyOn(api, "rooms").mockResolvedValue({
		rooms: [],
		pins: [],
		folders: [],
	});
	try {
		await open();
		await page.click(button("Archive Scout"));
		// The sheet gives way to the question.
		expect(currentAgentSheet()).toBeUndefined();
		await page.act(() => settle(60));
		const dialog = all<HTMLDialogElement>("dialog.sheet").find(
			(one) => one.getAttribute("aria-label") === "Archive Scout?",
		);
		expect(dialog?.open).toBe(true);
		expect(archive).not.toHaveBeenCalled();
		await page.click(
			[...(dialog?.querySelectorAll("button") ?? [])].find(
				(one) => one.textContent === "Archive",
			) ?? null,
		);
		await page.act(() => settle(60));
		expect(archive).toHaveBeenCalledWith("scout");
		// The room is gone from the list, so the page leaves it.
		expect(window.location.hash).toBe("#/rooms");
	} finally {
		archive.mockRestore();
		rooms.mockRestore();
	}
});

test("the coordinator's sheet has no Archive button", async () => {
	store.dispatch({
		type: "rooms_loaded",
		rooms: [view({ home: true, coordinator: true })],
	});
	await open();
	expect(button("Archive Scout")).toBeNull();
});

test("the home room of a team with no coordinator can be archived", async () => {
	store.dispatch({ type: "rooms_loaded", rooms: [view({ home: true })] });
	await open();
	expect(button("Archive Scout")).not.toBeNull();
});
