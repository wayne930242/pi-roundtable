import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import type { VirtualServer } from "pi-roundtable/kit";
import {
	describeDb,
	openTestStore,
	silentLogger,
	type TestStore,
	testDatabaseUrl,
} from "pi-roundtable/testing";
import {
	ConnectorError,
	ConnectorRegistry,
	DEFAULT_MAX_TOOL_NAME,
	DEFAULT_SERVER_PREFIX,
} from "./connector-registry.ts";
import {
	ContextForgeAdmin,
	ContextForgeError,
	type GatewayTool,
	type UpstreamAuth,
} from "./contextforge.ts";
import { CONNECTOR_MESSAGES } from "./messages.ts";

/** ContextForge in memory: gateways bring the tools a test gives them. */
class FakeAdmin {
	upstream: Record<string, string[]> = {};
	refuse: string | undefined;
	gateways = new Map<string, { slug: string; auth: UpstreamAuth }>();
	servers = new Map<string, { name: string; toolIds: string[] }>();
	#tools: GatewayTool[] = [
		{ id: "g1", name: "google-send-gmail-message", gatewaySlug: "google" },
	];
	#next = 0;

	async createGateway(gateway: {
		name: string;
		url: string;
		auth: UpstreamAuth;
	}) {
		if (this.refuse) throw new ContextForgeError(this.refuse);
		const id = `gw${++this.#next}`;
		this.gateways.set(id, { slug: gateway.name, auth: gateway.auth });
		for (const tool of this.upstream[gateway.url] ?? [])
			this.#tools.push({
				id: `${id}:${tool}`,
				name: `${gateway.name}-${tool}`,
				gatewaySlug: gateway.name,
			});
		return { id, slug: gateway.name };
	}
	async tools() {
		return this.#tools;
	}
	async createServer(name: string, _description: string, toolIds: string[]) {
		const id = `sv${++this.#next}`;
		this.servers.set(id, { name, toolIds });
		return id;
	}
	async deleteServer(id: string) {
		this.servers.delete(id);
	}
	async deleteGateway(id: string) {
		const slug = this.gateways.get(id)?.slug;
		this.gateways.delete(id);
		this.#tools = this.#tools.filter((t) => t.gatewaySlug !== slug);
	}
	resolve = async (name: string): Promise<VirtualServer> => {
		const server = [...this.servers.values()].find((s) => s.name === name);
		if (!server) throw new Error(`no server ${name}`);
		return {
			name,
			url: `http://cf/servers/${name}/mcp`,
			tools: this.#tools
				.filter((t) => server.toolIds.includes(t.id))
				.map((t) => t.name),
		};
	};
}

// Runs against a real PostgreSQL, only when ROUNDTABLE_TEST_DATABASE_URL is set.
describeDb("PostgreSQL", () => {
	let admin: FakeAdmin;
	const opened: TestStore<ConnectorRegistry>[] = [];

	async function open(): Promise<TestStore<ConnectorRegistry>> {
		const registry = await openTestStore(ConnectorRegistry, {
			admin,
			resolve: admin.resolve,
			logger: silentLogger(),
		});
		opened.push(registry);
		return registry;
	}

	beforeEach(async () => {
		const sql = new SQL(testDatabaseUrl);
		await sql`DROP TABLE IF EXISTS owner_connectors`;
		await sql.close();
		admin = new FakeAdmin();
		admin.upstream["https://mcp.notion.test/mcp"] = ["search", "get-page"];
	});

	afterEach(async () => {
		await Promise.all(opened.splice(0).map((r) => r.close()));
	});

	const notion = {
		name: "notion",
		url: "https://mcp.notion.test/mcp",
		description: "the owner's Notion pages",
		auth: { type: "bearer" as const, token: "secret-token" },
	};

	describe("ConnectorRegistry", () => {
		test("an added connector is a routable profile with its tools, and survives a restart", async () => {
			const registry = await open();
			const before = registry.version;
			const { connector, skipped } = await registry.add(notion);
			expect(skipped).toEqual([]);
			expect(connector.server?.tools).toEqual([
				"notion-search",
				"notion-get-page",
			]);
			expect(registry.version).toBe(before + 1);
			expect(registry.profileSources()).toEqual([
				{
					name: "notion",
					description: "the owner's Notion pages",
					serverName: `${DEFAULT_SERVER_PREFIX}notion`,
				},
			]);
			expect([...admin.gateways.values()][0]?.auth).toEqual(notion.auth);

			const reopened = await open();
			expect(reopened.servers().map((s) => s.tools)).toEqual([
				["notion-search", "notion-get-page"],
			]);
		});

		test("tools whose names are too long are skipped and listed", async () => {
			const long = "x".repeat(DEFAULT_MAX_TOOL_NAME);
			admin.upstream[notion.url] = ["search", long];
			const { connector, skipped } = await (await open()).add(notion);
			expect(connector.server?.tools).toEqual(["notion-search"]);
			expect(skipped).toEqual([`notion-${long}`]);
		});

		test.each([
			["a bad name", { name: "Notion!" }, CONNECTOR_MESSAGES.nameRule],
			["a bad URL", { url: "ftp://x" }, CONNECTOR_MESSAGES.urlRule],
			["no purpose", { description: " " }, CONNECTOR_MESSAGES.purposeRequired],
			[
				"a taken name",
				{ name: "google" },
				CONNECTOR_MESSAGES.nameTaken("google"),
			],
		])(
			"%s is refused before anything is registered",
			async (_n, change, message) => {
				const registry = await open();
				await expect(registry.add({ ...notion, ...change })).rejects.toThrow(
					message,
				);
				expect(admin.gateways.size).toBe(0);
			},
		);

		test("ContextForge's refusal reaches the owner, and nothing is left behind", async () => {
			admin.refuse = "Unable to connect to gateway";
			const registry = await open();
			await expect(registry.add(notion)).rejects.toThrow(ConnectorError);
			await expect(registry.add(notion)).rejects.toThrow(
				"Unable to connect to gateway",
			);
			expect(registry.list()).toEqual([]);
		});

		test("a server without tools is removed again", async () => {
			admin.upstream[notion.url] = [];
			const registry = await open();
			await expect(registry.add(notion)).rejects.toThrow(
				CONNECTOR_MESSAGES.noTools,
			);
			expect(admin.gateways.size).toBe(0);
			expect(registry.list()).toEqual([]);
		});

		test("describe changes the purpose; remove deletes it everywhere", async () => {
			const registry = await open();
			await registry.add(notion);
			await registry.describe("notion", "work notes");
			expect(registry.profileSources()[0]?.description).toBe("work notes");
			const before = registry.version;
			await registry.remove("notion");
			expect(registry.version).toBe(before + 1);
			expect(registry.list()).toEqual([]);
			expect(admin.gateways.size).toBe(0);
			expect(admin.servers.size).toBe(0);
			expect((await open()).list()).toEqual([]);
			await expect(registry.remove("notion")).rejects.toThrow(
				CONNECTOR_MESSAGES.unknownConnector("notion"),
			);
		});
	});
});

describe("ContextForgeAdmin", () => {
	test("a refused gateway's error never carries the token", async () => {
		const token = 'tok"en-123';
		const echo = (async (_url: string | URL | Request, init?: RequestInit) =>
			new Response(
				JSON.stringify({ detail: [{ msg: "bad", input: init?.body }] }),
				{ status: 422 },
			)) as typeof fetch;
		const cf = new ContextForgeAdmin("http://cf", "admin", echo);
		const error = await cf
			.createGateway({
				name: "x",
				url: "https://x.test/mcp",
				description: "x",
				auth: { type: "bearer", token },
			})
			.catch((e: unknown) => e);
		expect(error).toBeInstanceOf(ContextForgeError);
		expect(String(error)).not.toContain("en-123");
	});

	test("a refused gateway's error never carries a credential in its URL", async () => {
		const echo = (async (_url: string | URL | Request, init?: RequestInit) =>
			new Response(
				JSON.stringify({
					detail: `cannot reach ${JSON.parse(String(init?.body)).url}`,
				}),
				{ status: 502 },
			)) as typeof fetch;
		const cf = new ContextForgeAdmin("http://cf", "admin", echo);
		for (const url of [
			"https://mcp.test/mcp?api_key=query-secret-1",
			"https://mcp.test/s/path-secret-22/mcp",
			"https://user:pass-secret-3@mcp.test/mcp",
		]) {
			const error = String(
				await cf
					.createGateway({
						name: "x",
						url,
						description: "x",
						auth: { type: "none" },
					})
					.catch((e: unknown) => e),
			);
			expect(error).toContain("cannot reach");
			expect(error).not.toMatch(/secret/);
		}
	});

	test("a URL ending in /sse uses SSE; the header form sends the header", async () => {
		const bodies: unknown[] = [];
		const record = (async (
			_url: string | URL | Request,
			init?: RequestInit,
		) => {
			bodies.push(JSON.parse(String(init?.body)));
			return new Response(JSON.stringify({ id: "g", slug: "x" }));
		}) as typeof fetch;
		const cf = new ContextForgeAdmin("http://cf", "admin", record);
		await cf.createGateway({
			name: "x",
			url: "https://x.test/sse",
			description: "x",
			auth: { type: "header", name: "X-API-Key", value: "k" },
		});
		expect(bodies[0]).toMatchObject({
			transport: "SSE",
			auth_type: "authheaders",
			auth_header_key: "X-API-Key",
			auth_header_value: "k",
		});
	});
});
