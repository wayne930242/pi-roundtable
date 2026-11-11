import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import type {
	ConfigView,
	ProfileView,
	PushPrefsView,
} from "../src/api-types.ts";
import { openPage, releaseDom, type TestPage } from "./dom.ts";
import { ConfigContext } from "./lib/config.ts";
import { ProfilePage } from "./pages/profile.tsx";

// The profile page's two forms: the quiet hours and which account names the person.

const ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** The host's side: the stored quiet hours and the account that names the person. */
let quiet: PushPrefsView["quiet"];
let source: string | undefined;
let calls: { method: string; path: string; body: unknown }[] = [];

const profile = (): ProfileView => ({
	name: "Wei Hung",
	picture: false,
	principal: "p-wei",
	...(source ? { source } : {}),
	sources: [
		{ provider: "session", label: "Sign-in account" },
		{ provider: "discord", label: "Discord" },
	],
});

const realFetch = globalThis.fetch;
let page: TestPage;
beforeAll(async () => {
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
				principal: { id: "p-wei", name: "Wei Hung" },
				surface: "app",
				auth: "verifier",
				push: true,
			});
		if (path === "api/links") return Response.json({ links: [] });
		if (path === "api/push/prefs") {
			if (method === "PUT") quiet = body.quiet ?? undefined;
			return Response.json(quiet ? { quiet } : {});
		}
		if (path === "api/profile/source" && method === "PUT") {
			source = body.provider ?? undefined;
			return Response.json(profile());
		}
		if (path === "api/profile") return Response.json(profile());
		return Response.json({ error: "none" }, { status: 404 });
	}) as typeof fetch;
});
afterEach(async () => {
	await page.render(null);
	calls = [];
	quiet = undefined;
	source = undefined;
});
afterAll(async () => {
	globalThis.fetch = realFetch;
	await page.unmount();
	await releaseDom();
});

// No rooms: the page offers no knight, which the profile's own test covers.
const CONFIG: ConfigView = {
	title: "Console",
	panes: ["profile"],
	timeZone: "UTC",
	look: "modern",
};

const all = <T extends Element = HTMLElement>(selector: string): T[] => [
	...page.container.querySelectorAll<T>(selector),
];
const button = (label: string) =>
	all<HTMLButtonElement>("button").find(
		(one) => one.textContent?.trim() === label,
	) ?? null;
async function until(done: () => boolean, ms = 4000): Promise<void> {
	const stop = Date.now() + ms;
	while (!done() && Date.now() < stop)
		await page.act(() => new Promise<void>((r) => setTimeout(r, 25)));
}
const puts = (path: string) =>
	calls
		.filter((call) => call.method === "PUT" && call.path === path)
		.map((call) => call.body);

/** The control a label with these words wraps. */
function field(words: string): HTMLInputElement | HTMLSelectElement {
	const label = all<HTMLLabelElement>("label").find(
		(one) => one.textContent?.trim().startsWith(words) === true,
	);
	const control = label?.querySelector<HTMLInputElement | HTMLSelectElement>(
		"input, select",
	);
	if (!control) throw new Error(`no field ${words}`);
	return control;
}
const setValue = (
	element: HTMLInputElement | HTMLSelectElement,
	value: string,
) =>
	page.act(() => {
		const proto =
			element instanceof HTMLSelectElement
				? HTMLSelectElement.prototype
				: HTMLInputElement.prototype;
		Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(element, value);
		element.dispatchEvent(
			new Event(element instanceof HTMLSelectElement ? "change" : "input", {
				bubbles: true,
			}),
		);
	});

async function open() {
	await page.render(
		<ConfigContext.Provider value={CONFIG}>
			<ProfilePage />
		</ConfigContext.Provider>,
	);
	await until(() => button("Save") !== null);
}

test("the quiet hours start at 22:00 to 07:00, and Save sends the two times with the browser's time zone", async () => {
	await open();
	expect(field("From").value).toBe("22:00");
	expect(field("To").value).toBe("07:00");
	await setValue(field("From"), "23:30");
	await setValue(field("To"), "06:00");
	await page.click(button("Save"));
	await until(() => button("Turn off quiet hours") !== null);
	expect(puts("api/push/prefs")).toEqual([
		{ quiet: { start: "23:30", end: "06:00", timeZone: ZONE } },
	]);
});

test("saved quiet hours are shown as saved, Save sends them back unchanged, and turning them off sends none", async () => {
	quiet = { start: "22:10", end: "06:45", timeZone: "Asia/Taipei" };
	await open();
	expect(field("From").value).toBe("22:10");
	expect(field("To").value).toBe("06:45");
	await page.click(button("Save"));
	await until(() => puts("api/push/prefs").length === 1);
	expect(puts("api/push/prefs")).toEqual([
		{ quiet: { start: "22:10", end: "06:45", timeZone: ZONE } },
	]);
	await page.click(button("Turn off quiet hours"));
	await until(() => button("Turn off quiet hours") === null);
	expect(puts("api/push/prefs")[1]).toEqual({ quiet: null });
});

test("equal times cannot be saved", async () => {
	await open();
	await setValue(field("To"), "22:00");
	expect(button("Save")?.disabled).toBe(true);
});

test("the quiet hours are two drop-downs of half hours, and a saved time between two of them is an option of its own", async () => {
	quiet = { start: "22:10", end: "07:00", timeZone: "Asia/Taipei" };
	await open();
	const from = field("From");
	const to = field("To");
	expect(from.tagName).toBe("SELECT");
	expect(to.tagName).toBe("SELECT");
	expect(page.container.querySelector('input[type="time"]')).toBeNull();
	const times = (control: Element) =>
		[...control.querySelectorAll("option")].map((one) => one.value);
	expect(times(to)).toHaveLength(48);
	expect(times(to).slice(0, 3)).toEqual(["00:00", "00:30", "01:00"]);
	expect(times(to).at(-1)).toBe("23:30");
	// 22:10 was saved before the list: it stays what is chosen, in its place among the half hours.
	expect(times(from)).toHaveLength(49);
	expect(times(from).slice(44, 47)).toEqual(["22:00", "22:10", "22:30"]);
	expect(from.value).toBe("22:10");
});

test("the time zone stands in the row of the two times", async () => {
	await open();
	const row = field("From").closest(".time-range");
	expect(row?.querySelector(".time-range-zone")?.textContent).toBe(ZONE);
});

test("Shown as lists Automatic and each account as radio buttons of one group, and choosing one saves it", async () => {
	await open();
	const radios = all<HTMLInputElement>('input[type="radio"][name="shown-as"]');
	expect(radios.map((one) => one.closest("label")?.textContent)).toEqual([
		"Automatic",
		"Sign-in account",
		"Discord",
	]);
	expect(radios.map((one) => one.checked)).toEqual([true, false, false]);
	const group = radios[0]?.closest("fieldset");
	expect(group?.querySelector("legend")?.textContent).toBe("Shown as");
	await page.click(radios[2] ?? null);
	await until(
		() => all<HTMLInputElement>('input[name="shown-as"]')[2]?.checked === true,
	);
	expect(puts("api/profile/source")).toEqual([{ provider: "discord" }]);
	await page.click(all<HTMLInputElement>('input[name="shown-as"]')[0] ?? null);
	await until(() => puts("api/profile/source").length === 2);
	expect(puts("api/profile/source")[1]).toEqual({ provider: null });
});
