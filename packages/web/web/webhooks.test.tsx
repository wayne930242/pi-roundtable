import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	expect,
	spyOn,
	test,
} from "bun:test";
import type { ConfigView } from "../src/api-types.ts";
import type { WebhookView } from "../src/webhooks/types.ts";
import { AgentWebhooks } from "./components/agent-webhooks.tsx";
import { Toaster } from "./components/toaster.tsx";
import { openPage, releaseDom, type TestPage } from "./dom.ts";
import { ApiFailure } from "./lib/api.ts";
import { ConfigContext } from "./lib/config.ts";
import { webhooksApi } from "./lib/webhooks-api.ts";

const AT = "2026-11-08T08:00:00.000Z";
const URL_SHOWN = "https://hooks.example.test/app/hooks/h2/SECRET-TOKEN";
const config: ConfigView = {
	title: "Console",
	panes: ["rooms"],
	timeZone: "UTC",
	look: "modern",
};

let page: TestPage;
beforeAll(async () => {
	page = await openPage();
});
afterAll(async () => {
	await page.unmount();
	await releaseDom();
});

const settle = (ms = 40) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));
const button = (label: string) =>
	[...document.querySelectorAll<HTMLButtonElement>("button")].find(
		(one) => one.textContent?.trim() === label,
	) ?? null;
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

let hooks: WebhookView[];
let made: unknown[];
let revoked: string[];
let spies: ReturnType<typeof spyOn>[];

beforeEach(() => {
	hooks = [
		{
			id: "h1",
			name: "CI failures",
			createdBy: "owner",
			created: AT,
			lastUsed: null,
			expiresAt: null,
			once: false,
		},
		{
			id: "h3",
			name: "Deploy",
			createdBy: "scout",
			created: AT,
			lastUsed: AT,
			expiresAt: AT,
			once: true,
		},
	];
	made = [];
	revoked = [];
	spies = [
		spyOn(webhooksApi, "list").mockImplementation(async () =>
			hooks.map((one) => ({ ...one })),
		),
		spyOn(webhooksApi, "create").mockImplementation(async (agent, input) => {
			made.push({ agent, ...input });
			if (input.name === "taken") throw new ApiFailure("No more webhooks.");
			const hook: WebhookView = {
				id: "h2",
				name: input.name,
				createdBy: "owner",
				created: AT,
				lastUsed: null,
				expiresAt: null,
				once: false,
			};
			hooks.push(hook);
			return { webhook: hook, url: URL_SHOWN };
		}),
		spyOn(webhooksApi, "revoke").mockImplementation(async (_agent, id) => {
			revoked.push(id);
			hooks = hooks.filter((one) => one.id !== id);
		}),
	];
});
afterEach(async () => {
	for (const spy of spies) spy.mockRestore();
	await page.act(() => page.render(null));
});

const show = async () => {
	await page.render(
		<ConfigContext.Provider value={config}>
			<AgentWebhooks agent="scout" />
			<Toaster />
		</ConfigContext.Provider>,
	);
	await settle();
};

test("lists the knight's webhooks with who made them, their use and their expiry, and never a URL", async () => {
	await show();
	const text = page.container.textContent ?? "";
	expect(text).toContain("CI failures");
	expect(text).toContain("Made by an owner");
	expect(text).toContain("Never used");
	expect(text).toContain("Never expires");
	expect(text).toContain("Deploy");
	expect(text).toContain("Made by the knight");
	expect(text).toContain("One post");
	expect(text).not.toContain("/hooks/");
});

test("makes a webhook with an expiry and shows its URL once, with a copy button and the note", async () => {
	await show();
	const name = document.querySelector<HTMLInputElement>("form input");
	const expiry = document.querySelector<HTMLSelectElement>("form select");
	if (!name || !expiry) throw new Error("no form");
	await setValue(name, "Alerts");
	await setValue(expiry, "1440");
	await page.click(button("Make a webhook"));
	await settle();
	expect(made).toEqual([
		{ agent: "scout", name: "Alerts", expiresInMinutes: 1440 },
	]);
	const dialog = document.querySelector("dialog[open]");
	expect(dialog?.querySelector<HTMLInputElement>("input")?.value).toBe(
		URL_SHOWN,
	);
	expect(dialog?.textContent).toContain("shown only this once");
	expect(button("Copy")).not.toBeNull();
	await page.click(button("Done"));
	await page.act(() => settle(300));
	expect(document.body.innerHTML).not.toContain(URL_SHOWN);
	expect(page.container.textContent).toContain("Alerts");
	expect(page.container.textContent).not.toContain("SECRET-TOKEN");
});

test("says why a webhook was not made", async () => {
	await show();
	const name = document.querySelector<HTMLInputElement>("form input");
	if (!name) throw new Error("no form");
	await setValue(name, "taken");
	await page.click(button("Make a webhook"));
	await settle();
	expect(page.container.textContent).toContain("No more webhooks.");
	expect(document.querySelector("dialog[open]")).toBeNull();
});

test("revokes a webhook only after the person confirms", async () => {
	await show();
	const [first] = [
		...document.querySelectorAll<HTMLButtonElement>("button"),
	].filter((one) => one.textContent?.trim() === "Revoke");
	await page.click(first ?? null);
	await settle();
	expect(revoked).toEqual([]);
	expect(document.body.textContent).toContain(
		"Revoke CI failures? Its URL stops working at once.",
	);
	const confirm = [...document.querySelectorAll<HTMLButtonElement>("button")]
		.filter((one) => one.textContent?.trim() === "Revoke")
		.at(-1);
	await page.click(confirm ?? null);
	await settle();
	expect(revoked).toEqual(["h1"]);
	expect(page.container.textContent).not.toContain("CI failures");
});
