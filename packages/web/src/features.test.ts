import { describe, expect, test } from "bun:test";
import type { AgentTeam, ChannelKey } from "pi-roundtable";
import { partial, silentLogger } from "pi-roundtable/testing";
import type {
	ApiError,
	ConfigView,
	ConnectorsView,
	OverviewView,
	SkillDetailView,
} from "./api-types.ts";
import { ConsoleApi } from "./console-api.ts";
import type { ConsoleFeatures } from "./features.ts";
import {
	AGENT_CHANNEL,
	fakeMemory,
	fixtureSessions,
	GROUP_CHANNEL,
	HIDDEN_CHANNEL,
	OUTSIDE_SESSION,
	OWNER_CHANNEL,
} from "./testing/fixtures.ts";

const owner = `discord:${OWNER_CHANNEL}` as ChannelKey;
const agent = `discord:${AGENT_CHANNEL}` as ChannelKey;
const party = "discord:900000000000000088" as ChannelKey;
function fixture(change: Partial<ConsoleFeatures> = {}) {
	const calls: string[] = [];
	let changes = 0;
	const features: ConsoleFeatures = {
		party: {
			contains: (key) => key === party,
			list: async () => [
				{
					key: party,
					channelId: party.slice(8),
					channel: { kind: "unknown" },
					profile: "guest",
					enabledBy: "owner",
					enabledAt: "2026-01-01T00:00:00.000Z",
					container: "running",
					busy: 1,
				},
			],
		},
		schedules: { count: async (key) => (key === owner ? 3 : 0) },
		cleanup: {
			startFresh: async (key) => {
				calls.push(`fresh:${key}`);
				return "owner";
			},
			deleteConversation: async (key) => {
				calls.push(`delete:${key}`);
				return "deleted";
			},
		},
		skills: {
			catalog: () => [
				{
					name: "example",
					source: { kind: "builtin" },
					groups: ["team"],
					carriers: ["Scout"],
					description: "Safe <script> text",
				},
			],
			read: async () => ({
				frontmatter: {
					name: "example",
					metadata: { groups: ["team", "other"] },
					enabled: true,
				},
				body: "# Skill\n\n<script>bad()</script>",
			}),
		},
		connectors: {
			adminUrl: "/admin",
			gateways: async () => [
				{ name: "upstream", enabled: true, reachable: false, tools: 2 },
			],
			servers: async () => [{ name: "virtual", tools: ["lookup"] }],
			usedBy: () => ["owner", "Scout"],
		},
		...change,
	};
	const api = new ConsoleApi({
		title: "Console",
		timeZone: "Asia/Taipei",
		panes: ["overview", "notes", "conversations", "skills", "connectors"],
		sessionsDir: `${fixtureSessions()}/sessions`,
		team: partial<Pick<AgentTeam, "owns" | "status" | "guildId">>({
			guildId: "guild",
			owns: (key) =>
				key === agent
					? "agent"
					: key === `discord:${GROUP_CHANNEL}`
						? "group"
						: undefined,
			status: async () => ({ agents: [], groups: [] }),
		}),
		queue: { size: () => 1 },
		relayNotes: [],
		memory: fakeMemory(),
		features,
		exclude: (key) => key === `discord:${HIDDEN_CHANNEL}`,
		changed: () => changes++,
		logger: silentLogger(),
		presentation: {
			locale: "fr",
			messages: {
				"The note cannot be empty.": "Empty translated",
				"There is no such conversation.": "Missing translated",
			},
		},
		mountPath: "/console",
	});
	const call = async (path: string, method = "GET", body?: string) => {
		const response = await api.handle(
			new Request(`http://host/console/api/${path}`, {
				method,
				...(body !== undefined ? { body } : {}),
			}),
			path,
		);
		return { status: response.status, body: await response.json() };
	};
	return { api, call, calls, changes: () => changes, features };
}

describe("host feature ports", () => {
	test("overview combines owner workspaces/outside/schedules and separately stored party status", async () => {
		const { call } = fixture();
		const { body } = await call("overview");
		const view = body as OverviewView;
		expect(view.workspaces?.map((c) => c.key)).toEqual([owner]);
		expect(view.workspaces?.[0]?.schedules).toBe(3);
		expect(view.outside?.[0]?.key).toBe(`mcp:${OUTSIDE_SESSION}`);
		expect(view.party?.[0]).toMatchObject({
			key: party,
			container: "running",
			busy: 1,
		});
		expect(
			(await call(`conversations/${encodeURIComponent(party)}`)).status,
		).toBe(404);
	});
	test("cleanup admits existing owner/outside, agents/groups and party but never arbitrary paths or hidden keys", async () => {
		const { call, calls, changes } = fixture();
		for (const key of [
			owner,
			agent,
			party,
			`discord:${GROUP_CHANNEL}`,
			`mcp:${OUTSIDE_SESSION}`,
		])
			expect(
				(await call(`channels/${encodeURIComponent(key)}/start-over`, "POST"))
					.status,
			).toBe(200);
		for (const key of [
			"discord:../../etc",
			"mcp:nope",
			`discord:${HIDDEN_CHANNEL}`,
			"discord:900000000000000099",
			`agentgroup:${GROUP_CHANNEL}.scout`,
		])
			expect(
				(await call(`channels/${encodeURIComponent(key)}/start-over`, "POST"))
					.status,
			).toBe(404);
		for (const key of [agent, party, `discord:${GROUP_CHANNEL}`])
			expect(
				(await call(`channels/${encodeURIComponent(key)}/delete`, "POST"))
					.status,
			).toBe(404);
		expect(
			(await call(`channels/${encodeURIComponent(owner)}/delete`, "POST"))
				.status,
		).toBe(200);
		expect(calls).toHaveLength(6);
		expect(changes()).toBe(6);
	});
	test("a busy delete becomes conflict and emits no change", async () => {
		const { call, changes } = fixture({
			cleanup: {
				startFresh: async () => "owner",
				deleteConversation: async () => "busy",
			},
		});
		expect(
			(await call(`channels/${encodeURIComponent(owner)}/delete`, "POST"))
				.status,
		).toBe(409);
		expect(changes()).toBe(0);
	});
	test("full catalog and ordered flattened frontmatter/body use only a catalog-selected name", async () => {
		const { call } = fixture();
		expect((await call("skills")).body).toEqual([
			{
				name: "example",
				source: { kind: "builtin" },
				groups: ["team"],
				carriers: ["Scout"],
				description: "Safe <script> text",
			},
		]);
		const detail = (await call("skills/example")).body as SkillDetailView;
		expect(detail.metadata).toEqual([
			{ key: "name", value: "example" },
			{ key: "metadata.groups", value: "team, other" },
			{ key: "enabled", value: "true" },
		]);
		expect(detail.body).toContain("# Skill");
		expect((await call("skills/%2e%2e%2fsecret")).status).toBe(404);
	});
	test("malformed skills fail with a fixed message, not paths, unless the host opts in", async () => {
		const read = async () => {
			throw new Error("/private/secret.yml token");
		};
		const catalog = fixture().features.skills?.catalog;
		if (!catalog) throw new Error("fixture");
		const result = await fixture({ skills: { catalog, read } }).call(
			"skills/example",
		);
		expect(result.status).toBe(422);
		expect(JSON.stringify(result.body)).not.toContain("secret");
	});
	test("a skill of any size is shown, and a host that opts in sees why one cannot be read", async () => {
		const catalog = fixture().features.skills?.catalog;
		if (!catalog) throw new Error("fixture");
		const big = await fixture({
			skills: {
				catalog,
				read: async () => ({
					frontmatter: {},
					body: "x".repeat(2 * 1024 * 1024),
				}),
			},
		}).call("skills/example");
		expect(big.status).toBe(200);
		expect((big.body as SkillDetailView).body.length).toBe(2 * 1024 * 1024);
		const read = async () => {
			throw new Error("bad indentation at line 3");
		};
		const shown = await fixture({
			skills: { catalog, read, errorDetail: true },
		}).call("skills/example");
		expect(shown.status).toBe(422);
		expect(shown.body).toEqual({
			error:
				"The skill frontmatter could not be read: bad indentation at line 3",
		});
		const missing = await fixture({
			skills: {
				catalog: () =>
					catalog().map((s) => ({ ...s, missing: "no such file" })),
				read,
				errorDetail: true,
			},
		}).call("skills/example");
		expect(missing.body).toEqual({
			error: "The skill file is missing: no such file",
		});
	});
	test("connector gateway status/tool names and carrier usage are preserved", async () => {
		const view = (await fixture().call("connectors")).body as ConnectorsView;
		expect(view.gateways[0]).toMatchObject({
			enabled: true,
			reachable: false,
			tools: 2,
		});
		expect(view.servers[0]).toEqual({
			name: "virtual",
			tools: ["lookup"],
			usedBy: ["owner", "Scout"],
		});
	});
	test("connector failures return 502 without leaking upstream error details", async () => {
		const { call } = fixture({
			connectors: {
				gateways: async () => {
					throw new Error("secret endpoint");
				},
				servers: async () => [],
				usedBy: () => [],
			},
		});
		const response = await call("connectors");
		expect(response.status).toBe(502);
		expect(JSON.stringify(response.body)).not.toContain("secret");
	});
	test("localized config/errors and path routing reach the page; unsafe admin URLs do not", async () => {
		const { call } = fixture();
		const config = (await call("config")).body;
		expect(config).toMatchObject({
			locale: "fr",
			cleanup: true,
			connectorAdminUrl: "/admin",
			mountPath: "/console",
		});
		expect(
			(
				(
					await call(
						"notes",
						"POST",
						JSON.stringify({ fact: " ", kind: "note" }),
					)
				).body as ApiError
			).error,
		).toBe("Empty translated");
		expect(
			((await call("channels/mcp%3Anope/start-over", "POST")).body as ApiError)
				.error,
		).toBe("Missing translated");
		const unsafe = fixture({
			connectors: {
				adminUrl: "javascript:alert(1)",
				gateways: async () => [],
				servers: async () => [],
				usedBy: () => [],
			},
		});
		expect(
			((await unsafe.call("config")).body as ConfigView).connectorAdminUrl,
		).toBeUndefined();
	});
	test("disabled feature routes fail closed and malformed paths return 400", async () => {
		const { api, call } = fixture();
		expect((await call("skills/%E0%A4%A")).status).toBe(400);
		const response = await api.handle(
			new Request("http://host/console/api/skills/example/extra"),
			"skills/example/extra",
		);
		expect(response.status).toBe(404);
	});
});
