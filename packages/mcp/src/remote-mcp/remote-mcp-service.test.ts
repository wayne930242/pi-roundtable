import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { SQL } from "bun";
import { ChannelType, type Client } from "discord.js";
import {
	describeDb,
	openTestStore,
	type TestStore,
	testDatabaseUrl,
} from "pi-roundtable/testing";
import { ChannelGrantStore, hashChannelToken } from "./channel-grants.ts";
import { REMOTE_MCP_MESSAGES, remoteMcpMessages } from "./messages.ts";
import { RemoteMcpError, remoteMcpService } from "./remote-mcp-service.ts";

const OWNER = "100000000000000001";
const STRANGER = "100000000000000009";
const LOBBY = "200000000000000001";
const VOICE = "200000000000000002";

/**
 * A Discord client with one text channel, `#lobby`, that the owner may manage, and one voice
 * channel; `botMay` says whether the bot holds every permission there.
 */
function fakeClient(botMay = { value: true }): Client {
	const guild = {
		name: "Home",
		members: {
			fetch: async ({ user }: { user: string }) => ({ id: user }),
			fetchMe: async () => ({ id: "bot" }),
		},
	};
	const lobby = {
		id: LOBBY,
		type: ChannelType.GuildText,
		name: "lobby",
		guildId: "900",
		guild,
		isThread: () => false,
		permissionsFor: (member: { id: string }) => ({
			has: () => (member.id === "bot" ? botMay.value : member.id === OWNER),
		}),
	};
	const voice = { ...lobby, id: VOICE, type: ChannelType.GuildVoice };
	// SAFETY: the grant checks read only `channels.fetch` and the fields above.
	return {
		channels: {
			fetch: async (id: string) =>
				id === LOBBY ? lobby : id === VOICE ? voice : null,
		},
	} as unknown as Client;
}

// Runs against a real PostgreSQL, only when ROUNDTABLE_TEST_DATABASE_URL is set.
describeDb("REMOTE_MCP management", () => {
	let store: TestStore<ChannelGrantStore>;

	beforeAll(async () => {
		store = await openTestStore(ChannelGrantStore);
	});

	beforeEach(async () => {
		const sql = new SQL(testDatabaseUrl);
		await sql`DELETE FROM discord_channel_grants`;
		await sql`DELETE FROM discord_mcp_bundles`;
		await sql`DELETE FROM discord_channel_audit`;
		await sql.close();
	});

	afterAll(async () => {
		await store.close();
	});

	const service = (text = REMOTE_MCP_MESSAGES) =>
		remoteMcpService(store, text, "https://bot.example.test", "roundtable");

	const refusal = async (call: Promise<unknown>) => {
		const error = await call.then(
			() => undefined,
			(e: unknown) => e,
		);
		expect(error).toBeInstanceOf(RemoteMcpError);
		expect((error as RemoteMcpError).refusal).toBe(true);
		return (error as Error).message;
	};

	test("authorize creates the bundle and returns its URL once; a second channel grant keeps the URL", async () => {
		const mcp = service();
		const first = await mcp.authorize(fakeClient(), {
			bundle: " ops ",
			channelId: LOBBY,
			userId: OWNER,
			operations: ["read", "send"],
			description: "Small talk",
		});
		expect(first).toMatchObject({
			bundle: "ops",
			channelName: "lobby",
			operations: ["read", "send"],
		});
		const token = first.url?.split("/mcp/discord/")[1] ?? "";
		expect((await store.bundleByName("ops"))?.tokenHash).toBe(
			hashChannelToken(token),
		);
		const again = await mcp.authorize(fakeClient(), {
			bundle: "ops",
			channelId: LOBBY,
			userId: OWNER,
			operations: ["read"],
		});
		expect(again.url).toBeUndefined();
		const [bundle] = await mcp.bundles(fakeClient());
		expect(bundle).toMatchObject({
			name: "ops",
			grants: [
				{
					channelId: LOBBY,
					guildName: "Home",
					channelName: "lobby",
					visible: true,
					displayName: "lobby",
					description: "Small talk",
					operations: ["read"],
				},
			],
		});
		expect(bundle?.grants[0]?.audit.map((a) => a.tool)).toEqual([
			"authorize",
			"authorize",
		]);
	});

	test("authorize keeps the Discord flow's checks, in the configured wording", async () => {
		const text = remoteMcpMessages({ needManageChannels: "Not yours." });
		const mcp = service(text);
		const base = {
			bundle: "ops",
			channelId: LOBBY,
			userId: OWNER,
			operations: ["read"],
		};
		expect(
			await refusal(mcp.authorize(fakeClient(), { ...base, userId: STRANGER })),
		).toBe("Not yours.");
		expect(
			await refusal(mcp.authorize(fakeClient(), { ...base, channelId: VOICE })),
		).toBe(text.onlyTextChannels);
		expect(
			await refusal(
				mcp.authorize(fakeClient({ value: false }), {
					...base,
					operations: ["send"],
				}),
			),
		).toContain("The bot lacks");
		expect(
			await refusal(mcp.authorize(fakeClient(), { ...base, operations: [] })),
		).toBe(text.operationsRequired);
		expect(
			await refusal(
				mcp.authorize(fakeClient(), { ...base, operations: ["read", "ban"] }),
			),
		).toBe(text.operationsRequired);
		expect(
			await refusal(mcp.authorize(fakeClient(), { ...base, bundle: " " })),
		).toBe(text.bundleNameRule);
		expect(
			await refusal(mcp.authorize(fakeClient(), { ...base, channelId: "x" })),
		).toBe(text.channelIdRule);
		expect(await store.bundles()).toEqual([]);
	});

	test("describe, rotate and revoke act on a granted channel and refuse what is not", async () => {
		const mcp = service();
		const { url } = await mcp.authorize(fakeClient(), {
			bundle: "ops",
			channelId: LOBBY,
			userId: OWNER,
			operations: ["read"],
		});
		await mcp.describe("ops", LOBBY, {
			displayName: "Lobby",
			description: "Planning",
		});
		expect(await store.grants()).toMatchObject([
			{ displayName: "Lobby", description: "Planning" },
		]);
		expect(await refusal(mcp.describe("ops", LOBBY, {}))).toBe(
			REMOTE_MCP_MESSAGES.nameOrDescription,
		);
		expect(
			await refusal(mcp.describe("ops", VOICE, { displayName: "x" })),
		).toBe(REMOTE_MCP_MESSAGES.notInBundle("ops"));

		const rotated = await mcp.rotate("ops");
		expect(rotated.url).not.toBe(url);
		expect((await store.bundleByName("ops"))?.tokenHash).toBe(
			hashChannelToken(rotated.url.split("/mcp/discord/")[1] ?? ""),
		);
		expect(await refusal(mcp.rotate("nope"))).toBe(
			REMOTE_MCP_MESSAGES.noBundle("nope", "roundtable"),
		);

		await mcp.revoke("ops", LOBBY);
		expect(await store.grants()).toEqual([]);
		expect(await refusal(mcp.revoke("ops", LOBBY))).toBe(
			REMOTE_MCP_MESSAGES.revokeNotInBundle("ops"),
		);
	});

	test("a channel the bot cannot see is listed under its last known names", async () => {
		const mcp = service();
		await mcp.authorize(fakeClient(), {
			bundle: "ops",
			channelId: LOBBY,
			userId: OWNER,
			operations: ["read"],
		});
		// SAFETY: listing reads only `channels.fetch`.
		const blind = {
			channels: { fetch: async () => null },
		} as unknown as Client;
		const [bundle] = await mcp.bundles(blind);
		expect(bundle?.grants[0]).toMatchObject({
			channelName: "lobby",
			guildName: "Home",
			visible: false,
		});
	});
});

test("the service lists every operation with its label", () => {
	// SAFETY: listing the operations reads no store.
	const mcp = remoteMcpService(
		{} as ChannelGrantStore,
		REMOTE_MCP_MESSAGES,
		"https://bot.example.test",
		"roundtable",
	);
	expect(mcp.operations.map((o) => o.id)).toContain("read");
	expect(mcp.operations.every((o) => o.label.length > 0)).toBe(true);
});
