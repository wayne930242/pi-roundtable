import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import {
	CATALOG,
	type CharacterSpec,
	suggestCharacter,
} from "pi-roundtable/characters";
import type { AgentProfileView } from "../src/api-types.ts";
import { CharacterCreator } from "./components/character-creator.tsx";
import { openPage, releaseDom, type TestPage } from "./dom.ts";
import { loadKit } from "./lib/kit.ts";

const specOf = (id: "knight" | "wizard" | "healer"): CharacterSpec => ({
	v: 1,
	class: id,
	...CATALOG.classes[id].preset,
});

const profileOf = (character: CharacterSpec): AgentProfileView => ({
	name: "scout",
	displayName: "Scout",
	prompt: "Debugs and fixes failing builds",
	effective: { model: "m", thinking: "low" },
	avatar: "avatars/x.png",
	character,
	room: "app:agent.scout",
});

interface Call {
	url: string;
	method: string;
	body: unknown;
}
let calls: Call[] = [];
let answer: () => Response = () =>
	new Response(JSON.stringify(profileOf(specOf("wizard"))), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
const realFetch = globalThis.fetch;

let page: TestPage;
beforeAll(async () => {
	await loadKit();
	page = await openPage();
	globalThis.fetch = (async (
		url: string | URL | Request,
		init?: RequestInit,
	) => {
		calls.push({
			url: String(url),
			method: init?.method ?? "GET",
			body: init?.body ? JSON.parse(String(init.body)) : undefined,
		});
		return answer();
	}) as typeof fetch;
});
afterEach(async () => {
	await page.render(<></>);
	calls = [];
});
afterAll(async () => {
	globalThis.fetch = realFetch;
	await page.unmount();
	await releaseDom();
});

const query = <T extends Element>(selector: string): T | null =>
	page.container.querySelector<T>(selector);
/** The text of the dialogs that are showing; a closed sheet keeps its title in the page. */
const asking = (): string =>
	[...page.container.querySelectorAll("dialog")]
		.filter((one) => one.open)
		.map((one) => one.textContent)
		.join(" ");
const pressed = (selector: string) =>
	query(selector)?.getAttribute("aria-pressed") === "true";

/** The sheet slides away on a timer before it reports closed. */
const settle = () =>
	page.act(() => new Promise((done) => setTimeout(done, 300)));

async function open(
	saved: (profile: AgentProfileView) => void = () => undefined,
	character: CharacterSpec = specOf("knight"),
) {
	await page.render(
		<CharacterCreator
			name="scout"
			displayName="Scout"
			prompt="Debugs and fixes failing builds"
			character={character}
			onSaved={saved}
		/>,
	);
}

test("it offers all 24 classes and 8 palettes, with the saved ones chosen", async () => {
	await open();
	expect(page.container.querySelectorAll("[data-class]")).toHaveLength(24);
	expect(page.container.querySelectorAll("[data-palette]")).toHaveLength(8);
	expect(pressed('[data-class="knight"]')).toBe(true);
	expect(pressed('[data-palette="gules"]')).toBe(true);
	// Nothing changed yet: nothing to save.
	expect(query<HTMLButtonElement>('[data-action="save"]')?.disabled).toBe(true);
});

test("picking a class then Save sends PUT …/character with that class", async () => {
	let saved: AgentProfileView | undefined;
	await open((profile) => {
		saved = profile;
	});
	await page.click(query('[data-class="wizard"]'));
	expect(pressed('[data-class="wizard"]')).toBe(true);
	expect(pressed('[data-class="knight"]')).toBe(false);
	await page.click(query('[data-action="save"]'));
	expect(calls).toHaveLength(1);
	expect(calls[0]?.url).toBe("api/agents/scout/character");
	expect(calls[0]?.method).toBe("PUT");
	const sent = calls[0]?.body as { character: { class: string } };
	expect(sent.character.class).toBe("wizard");
	expect(saved?.character.class).toBe("wizard");
});

test("a color pick keeps the class and sends the colors", async () => {
	await open();
	await page.click(query('[data-palette="teal"]'));
	await page.click(query('[data-action="save"]'));
	const sent = calls[0]?.body as {
		character: { class: string; colors: { primary: string } };
	};
	expect(sent.character.class).toBe("knight");
	expect(sent.character.colors.primary).toBe(CATALOG.palettes.teal.primary);
});

test("Cancel with a change asks first; keeping the edit leaves it, discarding goes back to the saved look", async () => {
	await open();
	await page.click(query('[data-class="wizard"]'));
	await page.click(query('[data-action="cancel"]'));
	expect(asking()).toContain("Discard your changes?");
	expect(calls).toHaveLength(0);
	// Keep editing: the pick is still there.
	const keep = [...page.container.querySelectorAll("button")].find(
		(one) => one.textContent === "Keep editing",
	);
	await page.click(keep ?? null);
	await settle();
	expect(asking()).not.toContain("Discard your changes?");
	expect(pressed('[data-class="wizard"]')).toBe(true);
	await page.click(query('[data-action="cancel"]'));
	const discard = [...page.container.querySelectorAll("button")].find(
		(one) => one.textContent === "Discard",
	);
	await page.click(discard ?? null);
	await settle();
	expect(pressed('[data-class="knight"]')).toBe(true);
	expect(asking()).not.toContain("Discard your changes?");
	expect(calls).toHaveLength(0);
});

test("Cancel without a change asks nothing", async () => {
	await open();
	await page.click(query('[data-action="cancel"]'));
	expect(asking()).not.toContain("Discard your changes?");
});

test("the server's field error shows under that field, and the form stays editable", async () => {
	answer = () =>
		new Response(
			JSON.stringify({
				error: "hat: must be one of none, wizard",
				field: "hat",
			}),
			{ status: 400, headers: { "content-type": "application/json" } },
		);
	try {
		await open();
		await page.click(query('[data-hat="hood"]'));
		await page.click(query('[data-action="save"]'));
	} finally {
		answer = () =>
			new Response(JSON.stringify(profileOf(specOf("wizard"))), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
	}
	const message = query('[data-field="hat"] [role="alert"]');
	expect(message?.textContent).toContain("must be one of none, wizard");
	expect(query<HTMLButtonElement>('[data-action="save"]')?.disabled).toBe(
		false,
	);
});

test("Suggest from role picks the class the role points to, and Preview states cycles the preview", async () => {
	await open(undefined, specOf("wizard"));
	await page.click(query('[data-action="suggest"]'));
	const wanted = suggestCharacter({
		name: "scout",
		displayName: "Scout",
		prompt: "Debugs and fixes failing builds",
	}).class;
	expect(pressed(`[data-class="${wanted}"]`)).toBe(true);
	const host = () => query(".creator-preview .av-host");
	expect(host()?.getAttribute("data-state")).toBe("idle");
	await page.click(query('[data-action="cycle"]'));
	expect(host()?.getAttribute("data-state")).toBe("thinking");
});
