import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import {
	type ChannelExecutor,
	ChannelToolError,
	parseChannelTool,
} from "pi-roundtable/discord";
import {
	describeDb,
	openTestStore,
	type TestStore,
	testDatabaseUrl,
} from "pi-roundtable/testing";
import {
	type ChannelGrant,
	ChannelGrantStore,
	hashChannelToken,
	newChannelEndpoint,
} from "./channel-grants.ts";
import { runGrantedTool } from "./channel-tools.ts";
import { REMOTE_MCP_MESSAGES, remoteMcpMessages } from "./messages.ts";

describe("newChannelEndpoint", () => {
	test("puts a 43-character token in the URL and returns only its hash", () => {
		const endpoint = newChannelEndpoint("https://bot.example.com");
		const token = endpoint.url.split("/mcp/discord/")[1] ?? "";
		expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(endpoint.tokenHash).toBe(hashChannelToken(token));
		expect(() => newChannelEndpoint("http://bot.example.com")).toThrow();
	});
});

// Runs against a real PostgreSQL, only when ROUNDTABLE_TEST_DATABASE_URL is set.
describeDb("PostgreSQL", () => {
	let store: TestStore<ChannelGrantStore>;

	beforeAll(async () => {
		const sql = new SQL(testDatabaseUrl);
		await sql`DROP TABLE IF EXISTS discord_channel_grants`;
		await sql`DROP TABLE IF EXISTS discord_mcp_bundles`;
		await sql`DROP TABLE IF EXISTS discord_channel_audit`;
		await sql.close();
		store = await openTestStore(ChannelGrantStore);
	});

	afterAll(async () => {
		await store.close();
	});

	const grantFor = (bundleId: string, channelId: string): ChannelGrant => ({
		bundleId,
		channelId,
		guildId: "900",
		operations: ["read", "send"],
		displayName: "Lobby",
		description: "Small talk",
		guildName: "Example Server",
		channelName: "lobby-2",
		authorizedBy: "100000000000000001",
		authorizedAt: new Date(),
	});

	function fakeExecutor(guildId = "900") {
		const calls: string[] = [];
		const executor: ChannelExecutor = {
			inspect: async () => ({ guildId }),
			names: async () => ({
				guildName: "Example Server",
				channelName: "lobby-2",
			}),
			execute: async (tool) => {
				calls.push(tool);
				return { ok: tool };
			},
		};
		return { executor, calls };
	}

	describe("ChannelGrantStore", () => {
		test("keeps the first token of a bundle and rotates it on request", async () => {
			const first = await store.ensureBundle("sos", "hash-a", ["read"]);
			expect(first.created).toBe(true);
			const again = await store.ensureBundle("sos", "hash-b", ["send"]);
			expect(again.created).toBe(false);
			expect(again.bundle.tokenHash).toBe("hash-a");
			expect(again.bundle.defaultOperations).toEqual(["read"]);
			await store.rotateToken(first.bundle.id, "hash-c");
			expect(await store.bundleByTokenHash("hash-a")).toBeUndefined();
			expect((await store.bundleByTokenHash("hash-c"))?.id).toBe(
				first.bundle.id,
			);
		});

		test("saves, describes, lists, and revokes a grant with an audit trail", async () => {
			const { bundle } = await store.ensureBundle("grants", "hash-g", ["read"]);
			await store.save(grantFor(bundle.id, "111"));
			expect(
				await store.describe(bundle.id, "111", { description: "Planning" }),
			).toBe(true);
			const grant = await store.grant(bundle.id, "111");
			expect(grant?.displayName).toBe("Lobby");
			expect(grant?.description).toBe("Planning");
			expect(grant?.operations).toEqual(["read", "send"]);
			expect((await store.grants(bundle.id)).map((g) => g.channelId)).toEqual([
				"111",
			]);
			expect(await store.revoke(bundle.id, "111")).toBe(true);
			expect(await store.revoke(bundle.id, "111")).toBe(false);
			expect((await store.recentAudit("111")).map((a) => a.tool)).toEqual([
				"revoke",
				"authorize",
			]);
		});
	});

	describe("runGrantedTool", () => {
		test("runs a granted operation and records it", async () => {
			const { bundle } = await store.ensureBundle("run", "hash-r", ["read"]);
			await store.save(grantFor(bundle.id, "222"));
			const { executor, calls } = fakeExecutor();
			const args = parseChannelTool("discord_get_messages", {
				channelId: "222",
			});
			expect(args.limit).toBe(20);
			await runGrantedTool(
				bundle,
				"discord_get_messages",
				args,
				store,
				executor,
				REMOTE_MCP_MESSAGES,
			);
			expect(calls).toEqual(["discord_get_messages"]);
			expect((await store.recentAudit("222"))[0]).toMatchObject({
				tool: "discord_get_messages",
				status: "succeeded",
			});
		});

		test("the human part of a failed or unrecorded call is the host's wording, the code stays", async () => {
			const { bundle } = await store.ensureBundle("words", "hash-w", ["read"]);
			await store.save(grantFor(bundle.id, "555"));
			const text = remoteMcpMessages({
				codeDetail: (code, detail) => `${code}：${detail}`,
				operationFailed: (audit) => `紀錄 ${audit}`,
				outcomeUnrecorded: (audit) => `可能已完成，請勿重試。紀錄 ${audit}`,
			});
			const args = parseChannelTool("discord_get_messages", {
				channelId: "555",
			});
			const failing = fakeExecutor();
			failing.executor.execute = async () => {
				throw new Error("discord down");
			};
			const failed = await runGrantedTool(
				bundle,
				"discord_get_messages",
				args,
				store,
				failing.executor,
				text,
			).catch((error: unknown) => error);
			expect(failed).toBeInstanceOf(ChannelToolError);
			expect((failed as ChannelToolError).code).toMatch(
				/^DISCORD_OPERATION_FAILED：紀錄 [0-9a-f-]{36}$/,
			);
			const finish = store.finishCall;
			store.finishCall = async () => {
				throw new Error("db down");
			};
			const unrecorded = await runGrantedTool(
				bundle,
				"discord_get_messages",
				args,
				store,
				fakeExecutor().executor,
				text,
			)
				.catch((error: unknown) => error)
				.finally(() => {
					store.finishCall = finish;
				});
			expect((unrecorded as ChannelToolError).code).toMatch(
				/^DISCORD_OUTCOME_UNRECORDED：可能已完成，請勿重試。紀錄 [0-9a-f-]{36}$/,
			);
		});

		test("refuses an operation, channel, guild, or token outside the grant", async () => {
			const { bundle } = await store.ensureBundle("deny", "hash-d", ["read"]);
			await store.save(grantFor(bundle.id, "333"));
			const { executor, calls } = fakeExecutor();
			const refused = (tool: string, args: object, run = executor) =>
				expect(
					runGrantedTool(
						bundle,
						tool,
						parseChannelTool(tool, args),
						store,
						run,
						REMOTE_MCP_MESSAGES,
					),
				).rejects.toBeInstanceOf(ChannelToolError);
			await refused("discord_pin_message", {
				channelId: "333",
				messageId: "1",
			});
			await refused("discord_get_messages", { channelId: "444" });
			await refused(
				"discord_get_messages",
				{ channelId: "333" },
				fakeExecutor("901").executor,
			);
			await store.rotateToken(bundle.id, "hash-d2");
			await refused("discord_get_messages", { channelId: "333" });
			expect(calls).toEqual([]);
		});
	});
});

describe("parseChannelTool", () => {
	test.each([
		["an unknown tool", "discord_ban", { channelId: "1" }],
		["an extra argument", "discord_get_messages", { channelId: "1", x: 1 }],
		["a bad channel id", "discord_get_messages", { channelId: "abc" }],
		["an empty message", "discord_send_message", { channelId: "1" }],
		[
			"a date before Discord",
			"discord_search_messages",
			{ channelId: "1", afterDate: "2010-01-01T00:00:00Z" },
		],
		[
			"a reversed date range",
			"discord_search_messages",
			{
				channelId: "1",
				afterDate: "2026-02-01T00:00:00Z",
				beforeDate: "2026-01-01T00:00:00Z",
			},
		],
		[
			"a file name with a path",
			"discord_send_message",
			{
				channelId: "1",
				files: [{ filename: "../a.png", dataBase64: "AAAA" }],
			},
		],
		[
			"malformed base64",
			"discord_send_message",
			{ channelId: "1", files: [{ filename: "a.png", dataBase64: "A!!A" }] },
		],
	])("rejects %s", (_name, tool, args) => {
		expect(() => parseChannelTool(tool, args)).toThrow(ChannelToolError);
	});

	test("fills search defaults", () => {
		expect(
			parseChannelTool("discord_search_messages", { channelId: "1" }),
		).toMatchObject({ sort: "newest", limit: 25, offset: 0 });
	});
});
