import { afterAll, afterEach, beforeAll, beforeEach, spyOn } from "bun:test";
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
	openAgentSheet,
	rememberAgentTab,
} from "./lib/agent-sheet.ts";
import { api } from "./lib/api.ts";
import { store } from "./lib/app-store.ts";
import { ConfigContext } from "./lib/config.ts";
import { editApi } from "./lib/edit-api.ts";
import { loadKit } from "./lib/kit.ts";
import { clearRoomConfirm } from "./lib/room-confirm.ts";
import { setRouting } from "./lib/router.ts";
import { type AppConnection, setConnection } from "./lib/socket.ts";
import { teamApi } from "./lib/team-api.ts";
import { closeTeamSheet } from "./lib/team-sheet.ts";

// What the agent sheet's test files share: the knight, its room, the spies and how the sheet is opened.

export const SCOUT = "app:agent.scout";
export const config: ConfigView = {
	title: "Console",
	panes: ["rooms"],
	timeZone: "UTC",
	look: "modern",
};

export const character: CharacterSpec = {
	v: 1,
	class: "knight",
	...CATALOG.classes.knight.preset,
};

export const profile = (
	over: Partial<AgentProfileView> = {},
): AgentProfileView => ({
	name: "scout",
	displayName: "Scout",
	prompt: "You scout.\nBe brief.\nNever guess.",
	effective: { model: "model-a", thinking: "medium" },
	avatar: "avatars/x.png",
	character,
	room: SCOUT,
	...over,
});

export const view = (over: Partial<RoomView> = {}): RoomView => ({
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

export let page: TestPage;

export const settle = (ms = 40) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));
/**
 * Lets the page run, in `act`s, until `check` holds. A fixed `settle` guesses how long a promise,
 * an effect or a lazy chunk takes; a loaded machine takes longer than the guess.
 */
export async function settled(
	check: () => unknown,
	what: string,
	ms = 5000,
): Promise<void> {
	for (let waited = 0; !check(); waited += 20) {
		if (waited >= ms) throw new Error(`never settled: ${what}`);
		await page.act(() => settle(20));
	}
}
export const q = <T extends Element = HTMLElement>(
	selector: string,
): T | null => document.querySelector<T>(selector);
export const all = <T extends Element = HTMLElement>(selector: string): T[] => [
	...document.querySelectorAll<T>(selector),
];
export const typeInto = (
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
export const button = (text: string) =>
	all<HTMLButtonElement>("button").find(
		(one) => one.textContent?.trim() === text,
	) ?? null;
export const tabNamed = (text: string) =>
	all<HTMLButtonElement>(".agent-sheet [role=tab]").find(
		(one) => one.textContent === text,
	) ?? null;
/** The form's own submit button; the character creator has a Save of its own. */
export const submit = () =>
	q<HTMLButtonElement>(
		".agent-sheet [data-tab=profile] > form button[type=submit]",
	);
export const inReview = (text: string) =>
	all<HTMLButtonElement>(".review button").find(
		(one) => one.textContent === text,
	) ?? null;
export const model = () =>
	q<HTMLSelectElement>(".agent-sheet [data-tab=profile] > form select");
export const pickModel = (value: string) =>
	page.act(() => {
		const select = model();
		if (select) select.value = value;
		select?.dispatchEvent(new Event("change", { bubbles: true }));
	});

export let agent: ReturnType<typeof spyOn>;
export let models: ReturnType<typeof spyOn>;
export let update: ReturnType<typeof spyOn>;
export let skills: ReturnType<typeof spyOn>;
export let skillGroups: ReturnType<typeof spyOn>;
export let session: ReturnType<typeof spyOn>;
export const skillList = (carried: string[] = []): AgentSkillsView => ({
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

export const Host = () => (
	<ConfigContext.Provider value={config}>
		<AgentSheetHost />
		<RoomConfirmHost />
		<Toaster />
	</ConfigContext.Provider>
);

export async function open(
	options: { look?: boolean; skills?: boolean; creator?: boolean } = {},
) {
	await page.render(<Host />);
	await page.act(() =>
		openAgentSheet("scout", {
			look: options.look === true,
			skills: options.skills === true,
		}),
	);
	// The profile arrives, then the creator's chunk; each wait ends in an `act`, which draws what came.
	for (let waited = 0; waited < 5000; waited += 40) {
		await page.act(() => settle(40));
		// The creator is on the Look tab, which mounts when it is shown.
		if (
			(options.creator ?? options.look) !== true ||
			q(".agent-sheet .creator")
		)
			return;
	}
}

let helpersOn = false;
/** The host makes temp knights, for the rest of the test. */
export function withHelpers(): void {
	helpersOn = true;
}

/** Registers the hooks that open the test page and spy on the APIs the sheet reads, for one test file. */
export function setupAgentSheet(): void {
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
	beforeEach(() => {
		window.innerWidth = 1280;
		window.location.hash = "#/room/app%3Aagent.scout";
		store.dispatch({ type: "rooms_loaded", rooms: [view()] });
		agent = spyOn(api, "agent").mockResolvedValue(profile());
		models = spyOn(api, "models").mockResolvedValue({
			models: ["model-a", "model-b"],
		});
		update = spyOn(api, "updateAgent").mockImplementation(
			async (_name, patch) => profile(patch as Partial<AgentProfileView>),
		);
		skills = spyOn(teamApi, "skills").mockResolvedValue(skillList());
		skillGroups = spyOn(editApi, "skillGroups").mockResolvedValue({
			groups: [],
		});
		session = spyOn(api, "session").mockImplementation(async () => ({
			principal: { id: "owner", name: "Owner" },
			surface: "app",
			auth: "none",
			...(helpersOn ? { helpers: true as const } : {}),
		}));
	});
	afterEach(async () => {
		closeAgentSheet();
		await page.render(null);
		store.dispatch({ type: "rooms_loaded", rooms: [] });
		agent.mockRestore();
		models.mockRestore();
		update.mockRestore();
		skills.mockRestore();
		skillGroups.mockRestore();
		session.mockRestore();
		rememberAgentTab("profile");
		helpersOn = false;
		clearRoomConfirm();
		closeTeamSheet();
	});
}
