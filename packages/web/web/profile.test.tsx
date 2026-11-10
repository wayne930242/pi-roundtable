import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import {
	type CharacterSpec,
	resolveCharacter,
	suggestCharacter,
} from "pi-roundtable/characters";
import type { ConfigView, ProfileView } from "../src/api-types.ts";
import { Toaster } from "./components/toaster.tsx";
import { openPage, releaseDom, type TestPage } from "./dom.ts";
import { store } from "./lib/app-store.ts";
import { ConfigContext } from "./lib/config.ts";
import { loadKit } from "./lib/kit.ts";
import { ProfilePage } from "./pages/profile.tsx";

const ME = "p-wei";
const SUGGESTED = suggestCharacter({
	name: ME,
	displayName: "Wei Hung",
	prompt: "",
});

/** The host's side: the stored knight, and what the next save is refused with. */
let stored: CharacterSpec | undefined;
let refusal: { error: string; field: string } | undefined;
let calls: { method: string; path: string; body: unknown }[] = [];

const profile = (): ProfileView => ({
	name: "Wei Hung",
	picture: false,
	principal: ME,
	sources: [],
	...(stored ? { character: stored } : {}),
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
		const path = String(url);
		const method = init?.method ?? "GET";
		const body = init?.body ? JSON.parse(String(init.body)) : undefined;
		calls.push({ method, path, body });
		if (path === "api/session")
			return Response.json({
				principal: { id: ME, name: "Wei Hung" },
				surface: "app",
				auth: "verifier",
			});
		if (path === "api/links") return Response.json({ links: [] });
		if (path === "api/profile/character" && method === "PUT") {
			if (refusal) return Response.json(refusal, { status: 400 });
			stored = resolveCharacter(body.character, stored ?? SUGGESTED);
			return Response.json(profile());
		}
		if (path === "api/profile/character" && method === "DELETE") {
			stored = undefined;
			return Response.json(profile());
		}
		if (path === "api/profile") return Response.json(profile());
		return Response.json({ error: "none" }, { status: 404 });
	}) as typeof fetch;
});
afterEach(async () => {
	await page.render(null);
	calls = [];
	stored = undefined;
	refusal = undefined;
});
afterAll(async () => {
	globalThis.fetch = realFetch;
	await page.unmount();
	await releaseDom();
});

const ROOMS: ConfigView = {
	title: "Console",
	panes: ["rooms", "profile"],
	timeZone: "UTC",
	look: "modern",
	app: { surface: "app", protocol: "roundtable.app.v1" },
};

const q = <T extends Element = HTMLElement>(selector: string): T | null =>
	page.container.querySelector<T>(selector);
const button = (label: string) =>
	[...page.container.querySelectorAll<HTMLButtonElement>("button")].find(
		(one) => one.textContent?.trim() === label,
	) ?? null;
async function until(done: () => boolean, ms = 4000): Promise<void> {
	const stop = Date.now() + ms;
	while (!done() && Date.now() < stop)
		await page.act(() => new Promise<void>((r) => setTimeout(r, 25)));
}
const writes = () =>
	calls.filter((call) => call.path === "api/profile/character");

/** What the account head shows once its account picture, which this host does not serve, failed to load. */
async function headWithoutKnight(): Promise<string | undefined> {
	const image = q<HTMLImageElement>(".who .hpic img");
	// A picture that failed once is not asked for again in the page's life: the initials stand in.
	if (image) {
		if (image.getAttribute("src") !== `api/people/${ME}/picture`)
			throw new Error("the account head does not ask for the account picture");
		await page.act(() => {
			image.dispatchEvent(new Event("error"));
		});
	}
	return q(".who .hpic")?.textContent ?? undefined;
}

async function open(config: ConfigView = ROOMS) {
	store.dispatch({
		type: "ready",
		protocol: 1,
		principal: ME,
		name: "Wei Hung",
		...(stored ? { character: stored } : {}),
		uploads: { perMessage: 4, maxBytes: 1000 },
	} as never);
	await page.render(
		<ConfigContext.Provider value={config}>
			<ProfilePage />
			<Toaster />
		</ConfigContext.Provider>,
	);
	await until(() => q(".who") !== null);
}

test("without a knight the card offers to design one; saving the suggested look makes it the person's knight everywhere", async () => {
	await open();
	const card = q(".knight-card");
	expect(card?.querySelector("h2")?.textContent).toBe("Your knight");
	expect(button("Design my knight")).not.toBeNull();
	expect(button("Change look")).toBeNull();
	// The account head has no knight to draw: the account picture, and the initials when there is none.
	expect(await headWithoutKnight()).toBe("WH");

	await page.click(button("Design my knight"));
	await until(() => q("form.creator") !== null);
	// The creator stands in place of the page, on the look the person's id suggests.
	expect(q(".page-head")).toBeNull();
	expect(
		q(`[data-class="${SUGGESTED.class}"]`)?.getAttribute("aria-pressed"),
	).toBe("true");
	// A person has no role to suggest from.
	expect(q('[data-action="suggest"]')).toBeNull();
	// Nothing is saved yet, so the look as it stands can be saved.
	const save = q<HTMLButtonElement>('[data-action="save"]');
	expect(save?.disabled).toBe(false);
	await page.click(save);
	await until(() => q(".knight-card") !== null);

	expect(writes().map((call) => call.method)).toEqual(["PUT"]);
	expect(stored).toEqual(SUGGESTED);
	expect(q(".knight-card .av-host")?.getAttribute("style")).toContain("96px");
	expect(button("Change look")).not.toBeNull();
	expect(button("Remove, back to the picture")).not.toBeNull();
	expect(button("Design my knight")).toBeNull();
	// The tab that saved shows it at once: the store holds it, and the account head draws it.
	expect(store.getState().principal?.character).toEqual(SUGGESTED);
	expect(q(".who .av-host[data-badge]")).not.toBeNull();
});

test("Change look opens the creator on the saved knight; a change is saved, Cancel leaves it as it was", async () => {
	stored = SUGGESTED;
	await open();
	await page.click(button("Change look"));
	await until(() => q("form.creator") !== null);
	// Nothing changed yet: nothing to save.
	expect(q<HTMLButtonElement>('[data-action="save"]')?.disabled).toBe(true);
	const other = SUGGESTED.class === "wizard" ? "knight" : "wizard";
	await page.click(q(`[data-class="${other}"]`));
	expect(q<HTMLButtonElement>('[data-action="save"]')?.disabled).toBe(false);
	await page.click(q('[data-action="save"]'));
	await until(() => q(".knight-card") !== null);
	expect(stored?.class).toBe(other);
	expect(store.getState().principal?.character?.class).toBe(other);

	// Cancel with nothing changed goes straight back.
	await page.click(button("Change look"));
	await until(() => q("form.creator") !== null);
	await page.click(q('[data-action="cancel"]'));
	await until(() => q(".knight-card") !== null);
	expect(writes()).toHaveLength(1);
	expect(stored?.class).toBe(other);
});

test("Cancel with unsaved changes asks first, and discarding goes back to the profile", async () => {
	stored = SUGGESTED;
	await open();
	await page.click(button("Change look"));
	await until(() => q("form.creator") !== null);
	const other = SUGGESTED.class === "wizard" ? "knight" : "wizard";
	await page.click(q(`[data-class="${other}"]`));
	await page.click(q('[data-action="cancel"]'));
	const asking = () =>
		[...page.container.querySelectorAll("dialog")]
			.filter((one) => one.open)
			.map((one) => one.textContent)
			.join(" ");
	expect(asking()).toContain("Discard your changes?");
	// Still in the creator until the person answers.
	expect(q("form.creator")).not.toBeNull();
	await page.click(button("Discard"));
	await until(() => q(".knight-card") !== null);
	expect(q("form.creator")).toBeNull();
	expect(writes()).toHaveLength(0);
	expect(stored).toEqual(SUGGESTED);
});

test("a refused field is shown in the creator, which stays open", async () => {
	await open();
	await page.click(button("Design my knight"));
	await until(() => q("form.creator") !== null);
	refusal = { error: "class: is not one of the classes", field: "class" };
	await page.click(q('[data-action="save"]'));
	await until(() => q(".field-error") !== null);
	expect(q('[data-field="class"] [role="alert"]')?.textContent).toContain(
		"class: is not one of the classes",
	);
	expect(q("form.creator")).not.toBeNull();
	expect(store.getState().principal?.character).toBeUndefined();
});

test("Remove asks, then takes the knight away: the card offers to design one again and the picture is back", async () => {
	stored = SUGGESTED;
	await open();
	expect(q(".who .av-host[data-badge]")).not.toBeNull();
	await page.click(button("Remove, back to the picture"));
	await until(() => button("Remove") !== null);
	expect(writes()).toHaveLength(0);
	await page.click(button("Remove"));
	await until(() => button("Design my knight") !== null);
	expect(writes().map((call) => call.method)).toEqual(["DELETE"]);
	expect(stored).toBeUndefined();
	expect(store.getState().principal?.character).toBeUndefined();
	expect(q(".who .av-host")).toBeNull();
	expect(await headWithoutKnight()).toBe("WH");
});

test("a host that serves no rooms draws no knight anywhere, so its profile has no card", async () => {
	const { app: _none, ...plain } = ROOMS;
	await open({ ...plain, panes: ["profile"] });
	expect(q(".who")).not.toBeNull();
	expect(q(".knight-card")).toBeNull();
	expect(button("Design my knight")).toBeNull();
});
