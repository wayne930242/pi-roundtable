import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	expect,
	spyOn,
	test,
} from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ConfigView, RoomView } from "../src/api-types.ts";
import type { WebhookOverviewView } from "../src/webhooks/types.ts";
import { AgentWebhooks } from "./components/agent-webhooks.tsx";
import { Toaster } from "./components/toaster.tsx";
import { openPage, releaseDom, type TestPage } from "./dom.ts";
import { closeAgentSheet, currentAgentSheet } from "./lib/agent-sheet.ts";
import { store } from "./lib/app-store.ts";
import { ConfigContext } from "./lib/config.ts";
import { loadKit } from "./lib/kit.ts";
import { webhooksApi } from "./lib/webhooks-api.ts";
import { MorePage } from "./pages/more.tsx";

const AT = "2026-11-08T08:00:00.000Z";
const URL_SHOWN = "https://hooks.example.test/app/hooks/h9/SECRET-TOKEN";
const config: ConfigView = {
	title: "Console",
	panes: ["rooms", "webhooks"],
	timeZone: "UTC",
	look: "modern",
};
const room = (name: string): RoomView => ({
	key: `app:agent.${name}`,
	kind: "agent",
	name,
	displayName: name[0]?.toUpperCase() + name.slice(1),
	home: false,
	readOnly: false,
	mode: { yolo: false, longRunning: false },
	typing: false,
	stoppable: false,
});
const hook = (
	agent: string,
	id: string,
	name: string,
	extra: Partial<WebhookOverviewView> = {},
): WebhookOverviewView => ({
	agent,
	agentDisplayName: agent[0]?.toUpperCase() + agent.slice(1),
	id,
	name,
	createdBy: "owner",
	created: AT,
	lastUsed: null,
	expiresAt: null,
	once: false,
	...extra,
});

let page: TestPage;
let hooks: WebhookOverviewView[];
const spies: { mockRestore(): void }[] = [];
const track = <T extends { mockRestore(): void }>(spy: T): T => {
	spies.push(spy);
	return spy;
};

beforeAll(async () => {
	await loadKit();
	page = await openPage();
});
afterAll(async () => {
	await page.unmount();
	await releaseDom();
});
beforeEach(() => {
	hooks = [
		hook("boss", "h1", "Alerts", { createdBy: "boss", once: true }),
		hook("scout", "h2", "CI failures", { lastUsed: AT, expiresAt: AT }),
	];
	store.dispatch({
		type: "rooms_loaded",
		rooms: [room("scout"), room("boss")],
	});
	track(
		spyOn(webhooksApi, "all").mockImplementation(async () =>
			hooks.map((one) => ({ ...one })),
		),
	);
	track(
		spyOn(webhooksApi, "list").mockImplementation(async (agent) =>
			hooks.filter((one) => one.agent === agent),
		),
	);
	track(
		spyOn(webhooksApi, "create").mockImplementation(async (agent, input) => {
			const made = hook(agent, "h9", input.name);
			hooks.push(made);
			return { webhook: made, url: URL_SHOWN };
		}),
	);
	track(
		spyOn(webhooksApi, "revoke").mockImplementation(async (agent, id) => {
			hooks = hooks.filter((one) => !(one.agent === agent && one.id === id));
		}),
	);
});
afterEach(async () => {
	for (const spy of spies.splice(0)) spy.mockRestore();
	for (const dismiss of all('.toaster [aria-label="Dismiss"]'))
		await page.click(dismiss);
	await page.render(null);
	closeAgentSheet();
	store.dispatch({ type: "rooms_loaded", rooms: [] });
});

const settle = (ms = 40) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));
const q = <T extends Element = HTMLElement>(selector: string): T | null =>
	document.querySelector<T>(selector);
const all = <T extends Element = HTMLElement>(selector: string): T[] => [
	...document.querySelectorAll<T>(selector),
];
const button = (label: string) =>
	all<HTMLButtonElement>("button")
		.filter((one) => one.textContent?.trim() === label)
		.at(-1) ?? null;
const sheet = () => all<HTMLDialogElement>("dialog.sheet[open]").at(-1);
const owners = () =>
	all("[data-owner]").map((one) => one.getAttribute("data-owner"));
const rows = () =>
	all("[data-webhooks-page] [data-webhook]").map((one) =>
		one.getAttribute("data-webhook"),
	);
const change = (element: Element | null, value: string) =>
	page.act(() => {
		if (!(element instanceof HTMLInputElement))
			throw new Error("nothing to change");
		Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value",
		)?.set?.call(element, value);
		element.dispatchEvent(new Event("input", { bubbles: true }));
	});

async function open(): Promise<void> {
	const { default: WebhooksPage } = await import("./pages/webhooks.tsx");
	await page.render(
		<ConfigContext.Provider value={config}>
			<WebhooksPage />
			<Toaster />
		</ConfigContext.Provider>,
	);
	for (let waited = 0; waited < 3000; waited += 40) {
		await page.act(() => settle(40));
		if (q("[data-owner], .empty")) return;
	}
}

test("the page lists every knight's webhooks from the route, grouped by knight, never a URL", async () => {
	await open();
	expect(webhooksApi.all).toHaveBeenCalledTimes(1);
	expect(owners()).toEqual(["boss", "scout"]);
	expect(q("[data-owner=boss] .webhook-owner")?.textContent).toBe("Boss");
	expect(q("[data-owner=boss] svg, [data-owner=boss] img")).not.toBeNull();
	expect(rows()).toEqual(["h1", "h2"]);
	const text = (id: string) => q(`[data-webhook=${id}]`)?.textContent ?? "";
	expect(text("h1")).toContain("Made by the knight");
	expect(text("h1")).toContain("One post");
	expect(text("h2")).toContain("Made by an owner");
	expect(text("h2")).toContain("Last used");
	expect(text("h2")).toContain("Expires");
	expect(document.body.textContent).not.toContain("/hooks/");
	// A few webhooks need no search.
	expect(q("[data-webhooks-page] input[type=search]")).toBeNull();
});

test("tapping the knight opens its Edit knight sheet on the More tab", async () => {
	await open();
	await page.click(q("[data-owner=scout] .webhook-owner"));
	expect(currentAgentSheet()).toMatchObject({ name: "scout", tab: "more" });
});

test("revoking asks first, then calls DELETE for that knight's webhook and reads the list again", async () => {
	await open();
	await page.click(q("[data-webhook=h2] button.danger"));
	await page.act(() => settle(40));
	expect(webhooksApi.revoke).not.toHaveBeenCalled();
	expect(sheet()?.textContent).toContain(
		"Revoke CI failures? Its URL stops working at once.",
	);
	await page.click(button("Revoke"));
	await page.act(() => settle(80));
	expect(webhooksApi.revoke).toHaveBeenCalledWith("scout", "h2");
	expect(rows()).toEqual(["h1"]);
});

test("a new webhook picks the knight, takes a name, and shows its URL once", async () => {
	await open();
	await page.click(button("New webhook"));
	await page.act(() => settle(40));
	expect(sheet()?.getAttribute("aria-label")).toBe(
		"Which knight it belongs to",
	);
	const picks =
		sheet()?.querySelectorAll<HTMLInputElement>("input[type=checkbox]") ?? [];
	expect(picks).toHaveLength(2);
	await page.click(picks[0] ?? null);
	await page.click(button("Continue"));
	await page.act(() => settle(80));
	expect(sheet()?.getAttribute("aria-label")).toBe("New webhook");
	await change(sheet()?.querySelector("form input") ?? null, "Deploys");
	await page.click(button("Make a webhook"));
	await page.act(() => settle(80));
	expect(webhooksApi.create).toHaveBeenCalledWith("scout", { name: "Deploys" });
	expect(sheet()?.querySelector<HTMLInputElement>("input")?.value).toBe(
		URL_SHOWN,
	);
	await page.click(button("Done"));
	await page.act(() => settle(300));
	expect(document.body.innerHTML).not.toContain(URL_SHOWN);
	expect(rows()).toContain("h9");
});

test("more than a few webhooks bring the search field, which narrows by name or knight", async () => {
	hooks = [
		...hooks,
		...["a", "b", "c", "d"].map((n) => hook("scout", `x${n}`, `Extra ${n}`)),
	];
	await open();
	const search = q("[data-webhooks-page] input[type=search]");
	await change(search, "alerts");
	expect(rows()).toEqual(["h1"]);
	await change(search, "scout");
	expect(rows()).toEqual(["h2", "xa", "xb", "xc", "xd"]);
});

test("with no webhooks the page says in one line what a webhook is", async () => {
	hooks = [];
	await open();
	expect(q(".empty")?.textContent).toStartWith("No webhooks yet. A webhook is");
});

test("the knight's sheet section and the page draw a webhook with the same row", async () => {
	await page.render(
		<ConfigContext.Provider value={config}>
			<AgentWebhooks agent="scout" />
		</ConfigContext.Provider>,
	);
	await page.act(() => settle(40));
	const inSheet = q("[data-webhook=h2]")?.outerHTML;
	await page.render(null);
	await open();
	expect(q("[data-webhook=h2]")?.outerHTML).toBe(inSheet as string);
	// One copy of each part: both import the row and the form, and neither draws its own.
	const source = (file: string) =>
		readFileSync(join(import.meta.dir, file), "utf8");
	for (const file of ["components/agent-webhooks.tsx", "pages/webhooks.tsx"]) {
		expect(source(file)).toMatch(
			/WebhookRow,\n\tWebhookUrlDialog,\n} from "[./]+(components\/)?webhook-parts\.tsx"/,
		);
		expect(source(file)).not.toMatch(
			/function WebhookRow|<form|SecretUrlDialog/,
		);
	}
});

test("the More page links to the webhooks with an icon", async () => {
	await page.render(
		<MorePage items={[{ pane: "webhooks", label: "Webhooks" }]} />,
	);
	const link = q<HTMLAnchorElement>('a[href="#/webhooks"]');
	expect(link?.textContent).toBe("Webhooks");
	expect(link?.querySelector(".menu-icon svg")).not.toBeNull();
});
