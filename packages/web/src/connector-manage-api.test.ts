import { describe, expect, test } from "bun:test";
import { recordingLogger } from "pi-roundtable/testing";
import type {
	ConfigView,
	ConnectorAddedView,
	ManagedConnectorView,
	McpGrantsView,
} from "./api-types.ts";
import { displayUrl } from "./connector-manage-api.ts";
import { ConsoleApi, type ConsolePorts } from "./console-api.ts";
import type {
	ConnectorManagement,
	ConsoleActor,
	ManagedConnector,
	McpGrants,
} from "./features.ts";
import { fakeIdentity, fakeMemory } from "./testing/fixtures.ts";
import type { Visitor } from "./visitors.ts";

const TOKEN = "tok-SECRET-123";
const AT = new Date("2026-10-30T08:00:00.000Z");

const visitor = (tier: Visitor["tier"]): Visitor => ({
	principal: { id: `p-${tier}`, displayName: tier, disabled: false },
	tier,
	speakerId: `discord:${tier}`,
	roles: [],
});
const AS_OWNER = visitor("owner");

class Refusal extends Error {
	readonly refusal = true;
}

/** Fake ports that record each call, with a connector whose URL holds a credential. */
function ports() {
	const calls: unknown[][] = [];
	const connectors: ManagedConnector[] = [
		{
			name: "notion",
			url: "https://mcp.example.test/v1/key-SECRET?token=SECRET",
			description: "Pages",
			server: { tools: ["notion-search", "notion-get"] },
		},
		{ name: "plain", url: "https://plain.example.test/", description: "Plain" },
	];
	const manage: ConnectorManagement = {
		list: () => connectors,
		add: async (input) => {
			calls.push(["add", input]);
			if (input.name === "taken") throw new Refusal("The name is taken.");
			if (input.name === "boom") throw new Error(`upstream said ${TOKEN}`);
			// The port's own object may hold more than the page should see.
			const connector = {
				name: input.name,
				url: `${input.url}?k=${input.token}`,
				description: input.description,
				token: input.token,
				server: { tools: ["a"] },
			} as ManagedConnector;
			return { connector, skipped: ["a-very-long-tool"] };
		},
		describe: async (name, description) => {
			calls.push(["describe", name, description]);
			return {};
		},
		remove: async (name) => {
			calls.push(["remove", name]);
		},
	};
	const grants: McpGrants = {
		operations: [
			{ id: "read", label: "Read messages" },
			{ id: "send", label: "Send messages" },
		],
		bundles: async () => [
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
						operations: ["read"],
						authorizedAt: AT,
						audit: [{ tool: "authorize", status: "succeeded", createdAt: AT }],
					},
				],
			},
		],
		channels: async (actor) => {
			calls.push(["channels", actor]);
			return [{ id: "200", name: "lobby", guild: "Home" }];
		},
		revoke: async (bundle, channelId) => {
			calls.push(["revoke", bundle, channelId]);
		},
		describe: async (bundle, channelId, change) => {
			calls.push(["describeGrant", bundle, channelId, change]);
		},
		rotate: async (bundle) => {
			calls.push(["rotate", bundle]);
			if (bundle === "nope") throw new Refusal('There is no bundle "nope".');
			return { url: "https://bot.example.test/mcp/discord/NEW" };
		},
		authorize: async (input, actor: ConsoleActor) => {
			calls.push(["authorize", input, actor]);
			return input.bundle === "fresh"
				? { bundle: "fresh", url: "https://bot.example.test/mcp/discord/F" }
				: { bundle: input.bundle };
		},
	};
	return { calls, manage, grants };
}

function api(change: Partial<ConsolePorts> = {}) {
	const fake = ports();
	const recorder = recordingLogger();
	let changed = 0;
	const instance = new ConsoleApi({
		title: "Test console",
		timeZone: "UTC",
		panes: ["connectors"],
		tierPanes: { owner: ["connectors"], admin: ["connectors"], member: [] },
		sessionsDir: "/nonexistent",
		queue: { size: () => 0 },
		channelName: async () => undefined,
		memoryOf: () => fakeMemory(),
		people: fakeIdentity([]),
		exclude: () => false,
		relayNotes: [],
		changed: () => {
			changed += 1;
		},
		logger: recorder.logger,
		features: {
			connectors: {
				gateways: async () => [],
				servers: async () => [],
				usedBy: () => [],
				manage: fake.manage,
			},
			mcpGrants: fake.grants,
		},
		...change,
	});
	return { instance, ...fake, logger: recorder, changes: () => changed };
}

async function call<T>(
	instance: ConsoleApi,
	method: string,
	path: string,
	body?: unknown,
	who: Visitor = AS_OWNER,
): Promise<{ status: number; body: T; text: string }> {
	const response = await instance.handle(
		new Request(`http://console/api/${path}`, {
			method,
			...(body === undefined
				? {}
				: {
						body: JSON.stringify(body),
						headers: { "content-type": "application/json" },
					}),
		}),
		path,
		who,
	);
	const text = await response.text();
	return { status: response.status, body: JSON.parse(text) as T, text };
}

describe("connector management routes", () => {
	test("the list shows scheme and host only, so a credential in the path or query never shows", async () => {
		const { instance } = api();
		const { status, body, text } = await call<ManagedConnectorView[]>(
			instance,
			"GET",
			"connectors/managed",
		);
		expect(status).toBe(200);
		expect(body).toEqual([
			{
				name: "notion",
				displayUrl: "https://mcp.example.test/…",
				description: "Pages",
				tools: 2,
			},
			{
				name: "plain",
				displayUrl: "https://plain.example.test",
				description: "Plain",
			},
		]);
		expect(text).not.toContain("SECRET");
	});

	test("add hands the token to the port and no response echoes it", async () => {
		const { instance, calls, changes } = api();
		const added = await call<ConnectorAddedView>(
			instance,
			"POST",
			"connectors/managed",
			{
				name: "docs",
				url: "https://docs.example.test/mcp",
				description: "Docs",
				header: "X-API-Key",
				token: TOKEN,
			},
		);
		expect(added.status).toBe(201);
		expect(added.body).toEqual({
			connector: {
				name: "docs",
				displayUrl: "https://docs.example.test/…",
				description: "Docs",
				tools: 1,
			},
			skipped: ["a-very-long-tool"],
		});
		expect(added.text).not.toContain(TOKEN);
		expect(calls[0]).toEqual([
			"add",
			{
				name: "docs",
				url: "https://docs.example.test/mcp",
				description: "Docs",
				header: "X-API-Key",
				token: TOKEN,
			},
		]);
		expect(changes()).toBe(1);

		// An empty header and token are left out, not sent as empty strings.
		await call(instance, "POST", "connectors/managed", {
			name: "open",
			url: "https://open.example.test/mcp",
			description: "Open",
			header: "",
			token: "",
		});
		expect(calls[1]).toEqual([
			"add",
			{
				name: "open",
				url: "https://open.example.test/mcp",
				description: "Open",
			},
		]);
	});

	test("a refusal is the port's message; any other failure is logged and answered without its message", async () => {
		const { instance, logger } = api();
		const base = { url: "https://x.example.test/", description: "X" };
		const taken = await call<{ error: string }>(
			instance,
			"POST",
			"connectors/managed",
			{ ...base, name: "taken", token: TOKEN },
		);
		expect(taken).toMatchObject({
			status: 400,
			body: { error: "The name is taken." },
		});
		const boom = await call<{ error: string }>(
			instance,
			"POST",
			"connectors/managed",
			{ ...base, name: "boom", token: TOKEN },
		);
		expect(boom.status).toBe(502);
		expect(boom.text).not.toContain(TOKEN);
		expect(boom.body.error).toBe(
			"The connector service did not respond. Try again later.",
		);
		expect(logger.lines.map((l) => l.message)).toEqual([
			"connector management failed",
		]);
		const bad = await call(instance, "POST", "connectors/managed", {
			name: "x",
			url: 5,
			description: "X",
		});
		expect(bad.status).toBe(400);
	});

	test("describe and remove reach the port", async () => {
		const { instance, calls } = api();
		expect(
			(
				await call(instance, "PATCH", "connectors/managed/notion", {
					description: "Docs",
				})
			).status,
		).toBe(200);
		expect(
			(await call(instance, "DELETE", "connectors/managed/notion")).status,
		).toBe(200);
		expect(calls).toEqual([
			["describe", "notion", "Docs"],
			["remove", "notion"],
		]);
	});
});

describe("MCP authorization routes", () => {
	test("the bundles come with their channels, operations and recent audit", async () => {
		const { instance } = api();
		const { body } = await call<McpGrantsView>(
			instance,
			"GET",
			"connectors/grants",
		);
		expect(body).toEqual({
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
							operations: ["read"],
							authorizedAt: AT.toISOString(),
							audit: [
								{
									tool: "authorize",
									status: "succeeded",
									at: AT.toISOString(),
								},
							],
						},
					],
				},
			],
		});
	});

	test("channels and authorize carry the acting owner; a new bundle's URL is returned once", async () => {
		const { instance, calls } = api();
		const channels = await call(instance, "GET", "connectors/grants/channels");
		expect(channels.body).toEqual([
			{ id: "200", name: "lobby", guild: "Home" },
		]);
		const actor = { principalId: "p-owner", speakerId: "discord:owner" };
		expect(calls[0]).toEqual(["channels", actor]);
		const fresh = await call(instance, "POST", "connectors/grants", {
			bundle: "fresh",
			channelId: "200",
			operations: ["read", "send"],
			description: "Ops",
		});
		expect(fresh).toMatchObject({
			status: 201,
			body: { bundle: "fresh", url: "https://bot.example.test/mcp/discord/F" },
		});
		const again = await call(instance, "POST", "connectors/grants", {
			bundle: "ops",
			channelId: "200",
			operations: ["read"],
		});
		expect(again.body).toEqual({ bundle: "ops" });
		expect(calls[1]).toEqual([
			"authorize",
			{
				bundle: "fresh",
				channelId: "200",
				operations: ["read", "send"],
				description: "Ops",
			},
			actor,
		]);
		const bad = await call(instance, "POST", "connectors/grants", {
			bundle: "ops",
			channelId: "200",
			operations: "read",
		});
		expect(bad.status).toBe(400);
	});

	test("describe, revoke and rotate reach the port; a refusal is its message", async () => {
		const { instance, calls } = api();
		await call(instance, "PATCH", "connectors/grants/ops/200", {
			displayName: "Lobby",
			description: "",
		});
		await call(instance, "DELETE", "connectors/grants/ops/200");
		const rotated = await call(
			instance,
			"POST",
			"connectors/grants/ops/rotate",
		);
		expect(rotated.body).toEqual({
			bundle: "ops",
			url: "https://bot.example.test/mcp/discord/NEW",
		});
		const nope = await call(instance, "POST", "connectors/grants/nope/rotate");
		expect(nope).toMatchObject({
			status: 400,
			body: { error: 'There is no bundle "nope".' },
		});
		expect(calls.slice(0, 3)).toEqual([
			[
				"describeGrant",
				"ops",
				"200",
				{ displayName: "Lobby", description: "" },
			],
			["revoke", "ops", "200"],
			["rotate", "ops"],
		]);
	});
});

describe("who may manage", () => {
	const routes: [string, string, unknown?][] = [
		["GET", "connectors/managed"],
		[
			"POST",
			"connectors/managed",
			{ name: "x", url: "https://x/", description: "x" },
		],
		["PATCH", "connectors/managed/notion", { description: "x" }],
		["DELETE", "connectors/managed/notion"],
		["GET", "connectors/grants"],
		["GET", "connectors/grants/channels"],
		[
			"POST",
			"connectors/grants",
			{ bundle: "b", channelId: "1", operations: ["read"] },
		],
		["PATCH", "connectors/grants/ops/200", { displayName: "x" }],
		["DELETE", "connectors/grants/ops/200"],
		["POST", "connectors/grants/ops/rotate"],
	];

	test("a non-owner is refused even where the pane is served to their tier, and nothing reaches a port", async () => {
		const { instance, calls } = api();
		for (const [method, path, body] of routes) {
			expect({
				path,
				status: (await call(instance, method, path, body, visitor("admin")))
					.status,
			}).toEqual({
				path,
				status: 403,
			});
			expect({
				path,
				status: (await call(instance, method, path, body, visitor("member")))
					.status,
			}).toEqual({
				path,
				status: 404,
			});
		}
		expect(calls).toEqual([]);
	});

	test("a port the host does not serve answers 404, and the config names only the parts served", async () => {
		const bare = api({
			features: {
				connectors: {
					gateways: async () => [],
					servers: async () => [],
					usedBy: () => [],
				},
			},
		}).instance;
		for (const [method, path, body] of routes)
			expect((await call(bare, method, path, body)).status).toBe(404);
		const config = (instance: ConsoleApi) =>
			call<ConfigView>(instance, "GET", "config").then(
				(r) => r.body.connectorParts,
			);
		expect(await config(bare)).toEqual({ gateways: true });
		expect(await config(api().instance)).toEqual({
			gateways: true,
			manage: true,
			grants: true,
		});
		const grantsOnly = api({
			features: { mcpGrants: ports().grants },
		}).instance;
		expect(await config(grantsOnly)).toEqual({ grants: true });
		expect(await config(api({ features: {} }).instance)).toBeUndefined();
	});
});

test.each([
	["https://mcp.example.test/", "https://mcp.example.test"],
	["https://mcp.example.test/mcp", "https://mcp.example.test/…"],
	["https://mcp.example.test/?key=secret", "https://mcp.example.test/…"],
	["https://mcp.example.test/#frag", "https://mcp.example.test/…"],
	["https://user:pw@mcp.example.test/", "https://mcp.example.test/…"],
])("displayUrl shows %s as %s", (url, shown) => {
	expect(displayUrl(url)).toBe(shown);
});

test("displayUrl gives nothing for a URL that cannot be parsed", () => {
	expect(displayUrl("not a url")).toBeUndefined();
});
