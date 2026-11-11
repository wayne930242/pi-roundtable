import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import type { McpToolHints, VirtualServer } from "pi-roundtable/kit";
import {
	describeDb,
	openTestStore,
	silentLogger,
	type TestStore,
	testDatabaseUrl,
} from "pi-roundtable/testing";
import {
	ConnectorError,
	ConnectorRateLimited,
	ConnectorRegistry,
	DEFAULT_MAX_TOOL_NAME,
	DEFAULT_SERVER_PREFIX,
} from "./connector-registry.ts";
import {
	ContextForgeAdmin,
	ContextForgeError,
	type GatewayTool,
	type UpstreamAuth,
	VirtualServerRequestError,
} from "./contextforge.ts";
import { CONNECTOR_MESSAGES } from "./messages.ts";
import { toolHintsHoldRule } from "./tool-hints.ts";

/** ContextForge in memory: gateways bring the tools a test gives them. */
class FakeAdmin {
	upstream: Record<string, string[]> = {};
	/** The MCP hints ContextForge holds for a tool, by its full name. */
	hints: Record<string, McpToolHints> = {};
	refuse: string | undefined;
	/** Upstream URLs whose refresh ContextForge refuses. */
	refreshRefused = new Map<string, string>();
	/** Upstream URLs whose refresh ContextForge answers with 429. */
	refreshLimited = new Set<string>();
	/** The status ContextForge refuses the refresh of the upstream URLs in `refreshLimited` with. */
	limitStatus = 429;
	gateways = new Map<
		string,
		{ slug: string; url: string; auth: UpstreamAuth }
	>();
	servers = new Map<string, { name: string; toolIds: string[] }>();
	calls: string[] = [];
	/** The most calls that were in flight at once. */
	peak = 0;
	#active = 0;
	#tools: GatewayTool[] = [
		{ id: "g1", name: "google-send-gmail-message", gatewaySlug: "google" },
	];
	#next = 0;

	async #call<T>(label: string, run: () => T): Promise<T> {
		this.calls.push(label);
		this.peak = Math.max(this.peak, ++this.#active);
		await Bun.sleep(2);
		this.#active -= 1;
		return run();
	}

	#bring(id: string, slug: string, url: string) {
		for (const tool of this.upstream[url] ?? [])
			this.#tools.push({
				id: `${id}:${tool}`,
				name: `${slug}-${tool}`,
				gatewaySlug: slug,
				gatewayId: id,
			});
	}

	async createGateway(gateway: {
		name: string;
		url: string;
		auth: UpstreamAuth;
	}) {
		if (this.refuse) throw new ContextForgeError(this.refuse);
		const id = `gw${++this.#next}`;
		this.gateways.set(id, {
			slug: gateway.name,
			url: gateway.url,
			auth: gateway.auth,
		});
		this.#bring(id, gateway.name, gateway.url);
		return { id, slug: gateway.name };
	}
	async tools() {
		return this.#call("tools", () =>
			this.#tools.map((t) => ({
				...t,
				...(this.hints[t.name] ? { hints: this.hints[t.name] } : {}),
			})),
		);
	}
	async refreshGateway(id: string, _url: string) {
		await this.#call(`refresh ${id}`, () => undefined);
		const gateway = this.gateways.get(id);
		if (!gateway) throw new ContextForgeError("no such gateway");
		const refused = this.refreshRefused.get(gateway.url);
		if (refused !== undefined) throw new ContextForgeError(refused);
		if (this.refreshLimited.has(gateway.url))
			throw new ContextForgeError("rate limit exceeded", this.limitStatus);
		// What ContextForge keeps of a gateway's tools is what its upstream still offers.
		this.#tools = this.#tools.filter((t) => t.gatewayId !== id);
		this.#bring(id, gateway.slug, gateway.url);
	}
	async setServerTools(id: string, toolIds: string[]) {
		await this.#call(`set ${id}`, () => undefined);
		const server = this.servers.get(id);
		if (!server) throw new ContextForgeError("no such server");
		server.toolIds = toolIds;
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
		const tools = this.#tools
			.filter((t) => server.toolIds.includes(t.id))
			.map((t) => t.name);
		const hints = Object.fromEntries(
			tools.flatMap((t) => (this.hints[t] ? [[t, this.hints[t]]] : [])),
		);
		return {
			name,
			url: `http://cf/servers/${name}/mcp`,
			tools,
			...(Object.keys(hints).length > 0 ? { hints } : {}),
		};
	};
}

// Runs against a real PostgreSQL, only when ROUNDTABLE_TEST_DATABASE_URL is set.
describeDb("PostgreSQL", () => {
	let admin: FakeAdmin;
	const opened: TestStore<ConnectorRegistry>[] = [];

	async function open(
		extra: { resyncIntervalMs?: number; resyncLockoutMs?: number } = {},
	): Promise<TestStore<ConnectorRegistry>> {
		const registry = await openTestStore(ConnectorRegistry, {
			admin,
			// The fake's resolve can be replaced by a test, so it is read when the registry asks.
			resolve: (name) => admin.resolve(name),
			logger: silentLogger(),
			resyncIntervalMs: 0,
			...extra,
		});
		opened.push(registry);
		// The plugin reads the stored connectors when the host starts.
		await registry.load();
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

		test("a removal the database fails leaves the connector known", async () => {
			const registry = await open();
			await registry.add(notion);
			await registry.close();
			await expect(registry.remove("notion")).rejects.toThrow();
			expect((await registry.resync("notion")).connector.name).toBe("notion");
		});

		describe("resync", () => {
			const renamed = ["search", "find-page"];

			test("a renamed tool attaches with its hints and a removed one detaches, while the connector stays as it was", async () => {
				const registry = await open();
				await registry.add(notion);
				const gatewayId = [...admin.gateways.keys()][0];
				const serverId = [...admin.servers.keys()][0];
				const before = registry.version;
				admin.upstream[notion.url] = renamed;
				admin.hints["notion-find-page"] = { readOnlyHint: true };

				const result = await registry.resync("notion");

				expect(result.added).toEqual(["notion-find-page"]);
				expect(result.removed).toEqual(["notion-get-page"]);
				expect(result.skipped).toEqual([]);
				expect(registry.servers()[0]?.tools).toEqual([
					"notion-search",
					"notion-find-page",
				]);
				expect(registry.servers()[0]?.hints).toEqual({
					"notion-find-page": { readOnlyHint: true },
				});
				// The names were listed beside the old ones while the gateway changed, then alone.
				expect(registry.version).toBe(before + 2);
				// The same gateway, virtual server, token, and purpose.
				expect([...admin.gateways.keys()]).toEqual([gatewayId as string]);
				expect([...admin.servers.keys()]).toEqual([serverId as string]);
				expect([...admin.gateways.values()][0]?.auth).toEqual(notion.auth);
				const [connector] = registry.list();
				expect(connector).toMatchObject({
					name: "notion",
					description: notion.description,
					gatewayId,
					serverId,
				});
				// The stored row is untouched, and a restart reads the new tools.
				const reopened = await open();
				expect(reopened.list()[0]).toMatchObject({ gatewayId, serverId });
				expect(reopened.servers()[0]?.tools).toEqual([
					"notion-search",
					"notion-find-page",
				]);
			});

			test("nothing to change leaves the version alone; changed hints alone bump it", async () => {
				const registry = await open();
				await registry.add(notion);
				const before = registry.version;
				const same = await registry.resync("notion");
				expect([same.added, same.removed]).toEqual([[], []]);
				expect(registry.version).toBe(before);
				admin.hints["notion-search"] = { destructiveHint: true };
				await registry.resync("notion");
				expect(registry.version).toBe(before + 1);
				expect(registry.servers()[0]?.hints).toEqual({
					"notion-search": { destructiveHint: true },
				});
			});

			test("skipped names are reported as at add", async () => {
				const registry = await open();
				await registry.add(notion);
				const long = "x".repeat(DEFAULT_MAX_TOOL_NAME);
				admin.upstream[notion.url] = ["search", long];
				const result = await registry.resync("notion");
				expect(result.skipped).toEqual([`notion-${long}`]);
				expect(registry.servers()[0]?.tools).toEqual(["notion-search"]);
			});

			test("a refresh ContextForge refuses leaves the server as it was", async () => {
				const registry = await open();
				await registry.add(notion);
				const before = registry.version;
				admin.refreshRefused.set(notion.url, "upstream is down");
				admin.upstream[notion.url] = renamed;
				const failed = registry.resync("notion");
				await expect(failed).rejects.toBeInstanceOf(ConnectorError);
				await expect(failed).rejects.toThrow("upstream is down");
				expect(registry.version).toBe(before);
				expect(registry.servers()[0]?.tools).toEqual([
					"notion-search",
					"notion-get-page",
				]);
				expect(admin.calls.some((c) => c.startsWith("set "))).toBe(false);
			});

			test("a read-back that fails after the update still lists the new destructive tool, so it is held", async () => {
				const registry = await open();
				await registry.add(notion);
				const before = registry.version;
				admin.upstream[notion.url] = ["search", "wipe"];
				admin.hints["notion-wipe"] = { destructiveHint: true };
				admin.resolve = async () => {
					throw new Error("timeout");
				};
				await expect(registry.resync("notion")).rejects.toThrow("timeout");
				// The gateway serves the new names; the cache lists them beside the old ones.
				expect(registry.servers()[0]?.tools).toEqual([
					"notion-search",
					"notion-get-page",
					"notion-wipe",
				]);
				expect(registry.version).toBe(before + 1);
				const rule = toolHintsHoldRule({ servers: () => registry.servers() });
				expect(rule.describe("notion-wipe", {}, {})).toContain("notion-wipe");
			});

			test("an upstream left with no tool keeps the old server, and so does a failed read of it", async () => {
				const registry = await open();
				await registry.add(notion);
				admin.upstream[notion.url] = [];
				await expect(registry.resync("notion")).rejects.toThrow(
					CONNECTOR_MESSAGES.noTools,
				);
				expect(admin.calls.some((c) => c.startsWith("set "))).toBe(false);
				expect(registry.servers()[0]?.tools).toHaveLength(2);
				expect([...admin.servers.values()][0]?.toolIds).toHaveLength(2);
			});

			test("resyncAll reports each connector, logs a failure, and removes none", async () => {
				admin.upstream["https://mcp.other.test/mcp"] = ["list"];
				const registry = await open();
				await registry.add(notion);
				await registry.add({
					...notion,
					name: "other",
					url: "https://mcp.other.test/mcp",
				});
				admin.upstream[notion.url] = renamed;
				admin.refreshRefused.set("https://mcp.other.test/mcp", "gone");
				const outcomes = await registry.resyncAll();
				expect(outcomes).toMatchObject([
					{ name: "notion", added: ["notion-find-page"] },
					{ name: "other", error: "gone" },
				]);
				expect(registry.list().map((c) => c.name)).toEqual(["notion", "other"]);
				expect(registry.servers().map((s) => s.tools)).toEqual([
					["notion-search", "notion-find-page"],
					["other-list"],
				]);
				expect(admin.servers.size).toBe(2);
			});

			test("resyncs run one after the other", async () => {
				const registry = await open();
				await registry.add(notion);
				admin.peak = 0;
				await Promise.all([
					registry.resync("notion"),
					registry.resync("notion"),
					registry.resyncAll(),
				]);
				expect(admin.peak).toBe(1);
			});

			test("a connector removed while a resync waits is refused, not revived, even while its row is still being deleted", async () => {
				const registry = await open();
				await registry.add(notion);
				const holder = new SQL(testDatabaseUrl);
				let removed: Promise<void> | undefined;
				try {
					// Another session holds the row, so the removal's DELETE lands only after the queued resync had its turn.
					await holder.begin(async (held) => {
						await held`SELECT FROM owner_connectors WHERE name = 'notion' FOR UPDATE`;
						const waiting = registry.resyncAll();
						const queued = registry.resync("notion");
						removed = registry.remove("notion");
						await waiting;
						await expect(queued).rejects.toThrow(
							CONNECTOR_MESSAGES.unknownConnector("notion"),
						);
					});
				} finally {
					await Promise.all([removed, holder.close()]);
				}
				expect(registry.list()).toEqual([]);
				expect(admin.servers.size).toBe(0);
			});

			test("an unknown name is refused before ContextForge is asked", async () => {
				const registry = await open();
				await expect(registry.resync("nope")).rejects.toThrow(
					CONNECTOR_MESSAGES.unknownConnector("nope"),
				);
				expect(admin.calls).toEqual([]);
			});

			describe("when ContextForge answers 429", () => {
				const other = "https://mcp.other.test/mcp";
				const third = "https://mcp.third.test/mcp";

				async function three(extra: { resyncLockoutMs?: number } = {}) {
					admin.upstream[other] = ["list"];
					admin.upstream[third] = ["read"];
					const registry = await open(extra);
					await registry.add(notion);
					await registry.add({ ...notion, name: "other", url: other });
					await registry.add({ ...notion, name: "third", url: third });
					for (const url of [notion.url, other, third])
						admin.upstream[url] = ["renamed"];
					admin.calls.length = 0;
					return registry;
				}

				test("resyncAll stops at the first one, keeps every old server, and reports the rest as not resynced", async () => {
					const registry = await three();
					admin.refreshLimited.add(other);
					const before = registry.version;
					const outcomes = await registry.resyncAll();
					expect(outcomes).toMatchObject([
						{ name: "notion", added: ["notion-renamed"] },
						{ name: "other", error: "rate limit exceeded" },
						{ name: "third", error: CONNECTOR_MESSAGES.resyncNotAttempted },
					]);
					// notion took five requests, other's refresh was the sixth; third was never asked.
					expect(admin.calls).toEqual([
						expect.stringMatching(/^refresh /),
						"tools",
						expect.stringMatching(/^set /),
						expect.stringMatching(/^refresh /),
					]);
					// Both names were listed while notion changed, then the new one alone.
					expect(registry.version).toBe(before + 2);
					expect(registry.servers().map((s) => s.tools)).toEqual([
						["notion-renamed"],
						["other-list"],
						["third-read"],
					]);
					expect(registry.list().map((c) => c.name)).toEqual([
						"notion",
						"other",
						"third",
					]);
				});

				test("a 429 on the read of the virtual server stops it just the same", async () => {
					const registry = await three();
					admin.resolve = async () => {
						throw new VirtualServerRequestError(429, "limit");
					};
					const outcomes = await registry.resyncAll();
					expect(outcomes).toMatchObject([
						{ name: "notion", error: "limit" },
						{ name: "other", error: CONNECTOR_MESSAGES.resyncNotAttempted },
						{ name: "third", error: CONNECTOR_MESSAGES.resyncNotAttempted },
					]);
					expect(
						admin.calls.filter((c) => c.startsWith("refresh ")),
					).toHaveLength(1);
				});

				test("resync of one connector fails with ConnectorRateLimited and asks once", async () => {
					const registry = await three();
					admin.refreshLimited.add(notion.url);
					await expect(registry.resync("notion")).rejects.toBeInstanceOf(
						ConnectorRateLimited,
					);
					expect(admin.calls).toHaveLength(1);
					expect(registry.servers()[0]?.tools).toEqual([
						"notion-search",
						"notion-get-page",
					]);
				});

				test.each([401, 403, 423])(
					"a %d from a locked or refused admin account stops it too",
					async (status) => {
						const registry = await three();
						admin.limitStatus = status;
						admin.refreshLimited.add(other);
						const outcomes = await registry.resyncAll();
						expect(outcomes).toMatchObject([
							{ name: "notion" },
							{ name: "other", error: "rate limit exceeded" },
							{ name: "third", error: CONNECTOR_MESSAGES.resyncNotAttempted },
						]);
						expect(admin.calls).toHaveLength(4);
					},
				);

				test("for the lockout time every resync is refused without a request, then asked again", async () => {
					const registry = await three({ resyncLockoutMs: 60 });
					admin.refreshLimited.add(notion.url);
					await expect(registry.resyncAll()).resolves.toMatchObject([
						{ name: "notion", error: "rate limit exceeded" },
						{ name: "other", error: CONNECTOR_MESSAGES.resyncNotAttempted },
						{ name: "third", error: CONNECTOR_MESSAGES.resyncNotAttempted },
					]);
					expect(admin.calls).toHaveLength(1);
					admin.refreshLimited.clear();
					await expect(registry.resync("other")).rejects.toThrow(
						CONNECTOR_MESSAGES.resyncNotAttempted,
					);
					await expect(registry.resyncAll()).resolves.toMatchObject([
						{ error: CONNECTOR_MESSAGES.resyncNotAttempted },
						{ error: CONNECTOR_MESSAGES.resyncNotAttempted },
						{ error: CONNECTOR_MESSAGES.resyncNotAttempted },
					]);
					expect(admin.calls).toHaveLength(1);
					await Bun.sleep(70);
					await registry.resync("other");
					expect(admin.calls.length).toBeGreaterThan(1);
				});

				test("another refusal does not stop the rest", async () => {
					const registry = await three();
					admin.refreshRefused.set(notion.url, "gone");
					const outcomes = await registry.resyncAll();
					expect(outcomes).toMatchObject([
						{ name: "notion", error: "gone" },
						{ name: "other", added: ["other-renamed"] },
						{ name: "third", added: ["third-renamed"] },
					]);
				});
			});

			test("requests are spaced by resyncIntervalMs, across resyncs", async () => {
				const registry = await open({ resyncIntervalMs: 40 });
				await registry.add(notion);
				const started = Date.now();
				await registry.resync("notion");
				await registry.resync("notion");
				// Two resyncs take ten slots; the first request waits for none, and the last one starts eight slots in.
				expect(Date.now() - started).toBeGreaterThanOrEqual(8 * 40 - 20);
			});

			test("a resync asks ContextForge for a refresh, the tools, and one update", async () => {
				const registry = await open();
				await registry.add(notion);
				admin.calls.length = 0;
				await registry.resync("notion");
				expect(admin.calls).toEqual([
					`refresh ${[...admin.gateways.keys()][0]}`,
					"tools",
					`set ${[...admin.servers.keys()][0]}`,
				]);
			});
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
