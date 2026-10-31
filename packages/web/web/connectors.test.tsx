import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	expect,
	spyOn,
	test,
} from "bun:test";
import type {
	ConfigView,
	ManagedConnectorView,
	McpGrantsView,
} from "../src/api-types.ts";
import { Toaster } from "./components/toaster.tsx";
import { openPage, releaseDom, type TestPage } from "./dom.ts";
import { ApiFailure, api } from "./lib/api.ts";
import { ConfigContext } from "./lib/config.ts";
import { connectorsApi } from "./lib/connectors-api.ts";
import { ConnectorsPage } from "./pages/connectors.tsx";

const TOKEN = "tok-SECRET-123";
const AT = "2026-10-30T08:00:00.000Z";
const NEW_URL = "https://bot.example.test/mcp/discord/NEWTOKEN";

const config = (parts: ConfigView["connectorParts"]): ConfigView => ({
	title: "Console",
	panes: ["connectors"],
	timeZone: "UTC",
	look: "modern",
	...(parts ? { connectorParts: parts } : {}),
});

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
const all = <T extends Element = HTMLElement>(selector: string): T[] => [
	...document.querySelectorAll<T>(selector),
];
const button = (label: string, within: ParentNode = document) =>
	[...within.querySelectorAll<HTMLButtonElement>("button")].find(
		(one) => one.textContent?.trim() === label,
	) ?? null;
const openDialog = () => document.querySelector("dialog[open]");
/** The control of the open dialog's label that starts with `text`. */
const field = <T extends HTMLElement>(text: string): T => {
	const label = [...(openDialog()?.querySelectorAll("label") ?? [])].find(
		(one) => one.textContent?.trim().startsWith(text),
	);
	const control =
		label?.querySelector<T>("input, textarea, select") ??
		(label?.htmlFor ? document.getElementById(label.htmlFor) : null);
	if (!control) throw new Error(`no field ${text}`);
	return control as T;
};
const typeInto = (element: HTMLElement, value: string) =>
	page.act(() => {
		const proto =
			element instanceof HTMLTextAreaElement
				? HTMLTextAreaElement.prototype
				: element instanceof HTMLSelectElement
					? HTMLSelectElement.prototype
					: HTMLInputElement.prototype;
		Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(element, value);
		element.dispatchEvent(
			new Event(element instanceof HTMLSelectElement ? "change" : "input", {
				bubbles: true,
			}),
		);
	});
const submit = (form: Element | null | undefined) =>
	page.act(() => {
		form?.dispatchEvent(
			new Event("submit", { bubbles: true, cancelable: true }),
		);
	});

let connectors: ManagedConnectorView[];
let grants: McpGrantsView;
let spies: ReturnType<typeof spyOn>[];
let added: unknown[];
let calls: unknown[][];

beforeEach(() => {
	// A phone: the dialogs rise from the bottom edge.
	window.innerWidth = 390;
	window.innerHeight = 844;
	added = [];
	calls = [];
	connectors = [
		{
			name: "notion",
			displayUrl: "https://mcp.example.test/…",
			description: "Pages in Notion",
			tools: 2,
		},
		{ name: "broken", description: "Unreadable" },
	];
	grants = {
		operations: [
			{ id: "read", label: "Read messages" },
			{ id: "send", label: "Send messages" },
		],
		bundles: [
			{
				name: "ops",
				grants: [
					{
						channelId: "200",
						guildName: "Home",
						channelName: "lobby",
						visible: true,
						displayName: "Lobby",
						description: "Small talk",
						operations: ["read", "send"],
						authorizedAt: AT,
						audit: [
							{ tool: "discord_send_message", status: "succeeded", at: AT },
						],
					},
				],
			},
		],
	};
	spies = [
		spyOn(connectorsApi, "list").mockImplementation(async () =>
			connectors.map((c) => ({ ...c })),
		),
		spyOn(connectorsApi, "add").mockImplementation(async (input) => {
			added.push(input);
			if (input.name === "taken")
				throw new ApiFailure("The name `taken` is already taken.");
			const connector = {
				name: input.name,
				displayUrl: "https://new.example.test/…",
				description: input.description,
				tools: 1,
			};
			connectors = [...connectors, connector];
			return { connector, skipped: [] };
		}),
		spyOn(connectorsApi, "describe").mockImplementation(async (name, text) => {
			calls.push(["describe", name, text]);
			return {};
		}),
		spyOn(connectorsApi, "remove").mockImplementation(async (name) => {
			calls.push(["remove", name]);
			connectors = connectors.filter((c) => c.name !== name);
			return {};
		}),
		spyOn(connectorsApi, "grants").mockImplementation(async () => grants),
		spyOn(connectorsApi, "channels").mockImplementation(async () => [
			{ id: "200", name: "lobby", guild: "Home" },
			{ id: "201", name: "ops-room", guild: "Home" },
		]),
		spyOn(connectorsApi, "authorize").mockImplementation(async (input) => {
			calls.push(["authorize", input]);
			return { bundle: input.bundle, url: NEW_URL };
		}),
		spyOn(connectorsApi, "describeGrant").mockImplementation(
			async (bundle, channelId, change) => {
				calls.push(["describeGrant", bundle, channelId, change]);
				return {};
			},
		),
		spyOn(connectorsApi, "revoke").mockImplementation(
			async (bundle, channelId) => {
				calls.push(["revoke", bundle, channelId]);
				return {};
			},
		),
		spyOn(connectorsApi, "rotate").mockImplementation(async (bundle) => {
			calls.push(["rotate", bundle]);
			return { bundle, url: NEW_URL };
		}),
		spyOn(api, "connectors").mockImplementation(async () => ({
			gateways: [],
			servers: [],
		})),
	];
});
afterEach(async () => {
	await page.render(null);
	for (const spy of spies) spy.mockRestore();
});

async function show(
	parts: ConfigView["connectorParts"] = { manage: true, grants: true },
) {
	await page.render(
		<ConfigContext.Provider value={config(parts)}>
			<ConnectorsPage />
			<Toaster />
		</ConfigContext.Provider>,
	);
	await page.act(() => settle(80));
}

const card = (name: string) =>
	all("article.card").find(
		(one) => one.querySelector("strong")?.textContent === name,
	);

test("on a phone, the connectors show name, scheme and host, purpose and tool count, and the gateways are hidden when not served", async () => {
	expect(matchMedia("(max-width: 719px)").matches).toBe(true);
	await show();
	const notion = card("notion");
	expect(notion?.textContent).toContain("https://mcp.example.test/…");
	expect(notion?.textContent).toContain("Pages in Notion");
	expect(notion?.textContent).toContain("2 tools");
	expect(card("broken")?.textContent).toContain("Tools unreadable");
	expect(card("broken")?.textContent).toContain("(the URL cannot be parsed)");
	expect(api.connectors).not.toHaveBeenCalled();
	expect(document.body.textContent).not.toContain("Upstream gateways");
});

test("adding a connector sends the token once, and the form forgets it", async () => {
	await show();
	await page.click(button("Add connector"));
	await page.act(() => settle());
	expect(openDialog()?.textContent).toContain("Add an MCP connector");
	const token = field<HTMLInputElement>("Token");
	expect(token.type).toBe("password");
	await typeInto(field("Name"), "taken");
	await typeInto(field("MCP URL"), "https://new.example.test/mcp");
	await typeInto(field("Purpose"), "New things");
	await typeInto(token, TOKEN);
	await submit(openDialog()?.querySelector("form"));
	await page.act(() => settle());
	// A refusal keeps the form and what was typed, and says why.
	expect(openDialog()?.querySelector(".failure")?.textContent).toBe(
		"The name `taken` is already taken.",
	);
	await typeInto(field("Name"), "fresh");
	await submit(openDialog()?.querySelector("form"));
	await page.act(() => settle(300));
	expect(added[1]).toEqual({
		name: "fresh",
		url: "https://new.example.test/mcp",
		description: "New things",
		token: TOKEN,
	});
	expect(openDialog()).toBeNull();
	expect(card("fresh")?.textContent).toContain("https://new.example.test/…");
	expect(document.body.innerHTML).not.toContain(TOKEN);
	expect(
		all<HTMLInputElement>("input").some((one) => one.value === TOKEN),
	).toBe(false);
	// Opened again, the form starts empty.
	await page.click(button("Add connector"));
	await page.act(() => settle());
	expect(field<HTMLInputElement>("Token").value).toBe("");
});

test("a purpose is edited in a dialog, and a connector is removed only after confirming", async () => {
	await show();
	await page.click(button("Edit purpose", card("notion")));
	await page.act(() => settle());
	const purpose = field<HTMLTextAreaElement>("Purpose");
	expect(purpose.value).toBe("Pages in Notion");
	await typeInto(purpose, "Docs");
	await submit(openDialog()?.querySelector("form"));
	await page.act(() => settle(300));
	expect(calls).toEqual([["describe", "notion", "Docs"]]);

	await page.click(button("Remove", card("notion")));
	await page.act(() => settle());
	expect(openDialog()?.textContent).toContain("Remove notion and its token?");
	expect(calls).toHaveLength(1);
	const dialog = openDialog();
	await page.click(button("Remove", dialog ?? document));
	await page.act(() => settle(300));
	expect(calls[1]).toEqual(["remove", "notion"]);
	expect(card("notion")).toBeUndefined();
});

test("the MCP authorizations show each bundle's channels, operations and recent audit; revoking asks first", async () => {
	await show();
	const ops = card("ops");
	expect(ops?.textContent).toContain("Lobby");
	expect(ops?.textContent).toContain("Home › #lobby");
	expect(ops?.textContent).toContain("Small talk");
	expect(ops?.textContent).toContain("Allowed: Read messages, Send messages");
	expect(ops?.querySelector(".audit")?.textContent).toContain(
		"discord_send_message",
	);
	await page.click(button("Rename / purpose", ops));
	await page.act(() => settle());
	await typeInto(field("Name outside AI clients see"), "Front desk");
	await submit(openDialog()?.querySelector("form"));
	await page.act(() => settle(300));
	expect(calls[0]).toEqual([
		"describeGrant",
		"ops",
		"200",
		{ displayName: "Front desk", description: "Small talk" },
	]);
	await page.click(button("Revoke", card("ops")));
	await page.act(() => settle());
	expect(calls).toHaveLength(1);
	await page.click(button("Revoke", openDialog() ?? document));
	await page.act(() => settle());
	expect(calls[1]).toEqual(["revoke", "ops", "200"]);
});

test("a new URL is shown once with a copy button, and gone when the dialog closes", async () => {
	const copied: string[] = [];
	Object.defineProperty(navigator, "clipboard", {
		configurable: true,
		value: { writeText: async (text: string) => void copied.push(text) },
	});
	await show();
	await page.click(button("New URL", card("ops")));
	await page.act(() => settle());
	await page.click(button("Replace URL", openDialog() ?? document));
	await page.act(() => settle(300));
	expect(calls).toEqual([["rotate", "ops"]]);
	const shown = all<HTMLInputElement>("input.mcp-url").find((one) =>
		one.closest("dialog[open]"),
	);
	expect(shown?.value).toBe(NEW_URL);
	await page.click(button("Copy", openDialog() ?? document));
	await page.act(() => settle());
	expect(copied).toEqual([NEW_URL]);
	await page.click(button("Done", openDialog() ?? document));
	await page.act(() => settle(300));
	expect(document.body.innerHTML).not.toContain(NEW_URL);
});

test("authorizing picks a new bundle, a channel and its operations", async () => {
	await show();
	await page.click(button("Authorize a channel"));
	await page.act(() => settle(80));
	const authorize = () => button("Authorize", openDialog() ?? document);
	// No operation chosen yet.
	expect(authorize()?.disabled).toBe(true);
	await typeInto(field("Bundle"), " new");
	await typeInto(field("New bundle name"), "fresh");
	await typeInto(field("Channel"), "201");
	const send = [...(openDialog()?.querySelectorAll("label") ?? [])].find(
		(one) => one.textContent?.trim() === "Send messages",
	);
	await page.click(send?.querySelector("input") ?? null);
	expect(authorize()?.disabled).toBe(false);
	await submit(openDialog()?.querySelector("form"));
	await page.act(() => settle(300));
	expect(calls[0]).toEqual([
		"authorize",
		{ bundle: "fresh", channelId: "201", operations: ["send"] },
	]);
	// The new bundle's URL, this once.
	expect(
		openDialog()?.querySelector<HTMLInputElement>("input.mcp-url")?.value,
	).toBe(NEW_URL);
});

test("a section whose port the host does not serve is hidden", async () => {
	await show({ grants: true });
	expect(button("Add connector")).toBeNull();
	expect(connectorsApi.list).not.toHaveBeenCalled();
	expect(document.body.textContent).toContain("MCP authorizations");
	await show({ manage: true });
	expect(button("Authorize a channel")).toBeNull();
	expect(button("Add connector")).not.toBeNull();
});
