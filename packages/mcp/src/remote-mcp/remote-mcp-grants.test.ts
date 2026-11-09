import { expect, test } from "bun:test";
import { describeDb } from "pi-roundtable/testing";
import { fakeInteraction } from "../testing/fake-interaction.ts";
import {
	base,
	boot,
	PUBLIC_URL,
	sql,
	useRemoteMcpHarness,
} from "../testing/remote-mcp-fixture.ts";
import { ChannelGrantStore } from "./channel-grants.ts";
import { REMOTE_MCP_MESSAGES, type RemoteMcpMessages } from "./messages.ts";

// Runs against a real PostgreSQL, only when ROUNDTABLE_TEST_DATABASE_URL is set.
describeDb("remoteMcp on a plugin harness grant commands", () => {
	useRemoteMcpHarness();

	test("adds /<root> mcp with its five subcommands", async () => {
		const { discord } = await boot(base);
		const root = discord
			.compose()
			.commands.find((command) => command.name === "roundtable");
		const group = root?.options?.find((option) => option.name === "mcp");
		expect(
			(group as { options?: { name: string }[] } | undefined)?.options?.map(
				(option) => option.name,
			),
		).toEqual(["authorize", "grants", "revoke", "describe", "token"]);
	});

	test("the grant commands answer the owner, and refuse the cases that need a server", async () => {
		const { discord } = await boot(base);
		const [added] = discord.added().slice(-1);
		if (!added) throw new Error("the plugin added no command");
		const run = async (options: Parameters<typeof fakeInteraction>[0]) => {
			const { interaction, replies } = fakeInteraction({
				user: "owner",
				...options,
			});
			await added.module.handle(interaction as never);
			return replies.text();
		};
		await sql`DELETE FROM discord_mcp_bundles`;
		expect(await run({ group: "mcp", sub: "grants" })).toContain(
			REMOTE_MCP_MESSAGES.noGrants,
		);
		expect(
			await run({
				group: "mcp",
				sub: "authorize",
				strings: { bundle: "team" },
			}),
		).toContain(REMOTE_MCP_MESSAGES.useInServer);
		expect(
			await run({
				group: "mcp",
				sub: "revoke",
				guild: true,
				strings: { bundle: "team" },
			}),
		).toContain(REMOTE_MCP_MESSAGES.noBundle("team", "roundtable"));
	});

	/** The plugin's grant command module and a runner for interactions against it. */
	async function grantCommands(messages?: Partial<RemoteMcpMessages>) {
		const { discord } = await boot({ ...base, messages });
		const [added] = discord.added().slice(-1);
		if (!added) throw new Error("the plugin added no command");
		return async (options: Parameters<typeof fakeInteraction>[0]) => {
			const { interaction, replies } = fakeInteraction({
				user: "owner",
				...options,
			});
			await added.module.handle(interaction as never);
			return replies;
		};
	}

	/** A bundle with one granted channel, as a finished `authorize` leaves it. */
	async function seedBundle(name: string, tokenHash: string) {
		const grants = await ChannelGrantStore.attach(sql);
		await sql`DELETE FROM discord_mcp_bundles WHERE name = ${name}`;
		const { bundle } = await grants.ensureBundle(name, tokenHash, ["read"]);
		await grants.save({
			bundleId: bundle.id,
			channelId: "111",
			guildId: "900",
			operations: ["read"],
			displayName: "Lobby",
			description: "",
			guildName: "Example Server",
			channelName: "lobby",
			authorizedBy: "100000000000000001",
			authorizedAt: new Date(),
		});
		return { grants, bundle };
	}

	test("describe changes what the agent sees, and revoke removes the channel", async () => {
		const run = await grantCommands();
		const { grants, bundle } = await seedBundle("team", "hash-team");
		const described = await run({
			group: "mcp",
			sub: "describe",
			guild: true,
			strings: { bundle: "team", description: "Planning talk" },
		});
		expect(described.text()).toContain(REMOTE_MCP_MESSAGES.described);
		expect((await grants.grant(bundle.id, "111"))?.description).toBe(
			"Planning talk",
		);
		const revoked = await run({
			group: "mcp",
			sub: "revoke",
			guild: true,
			strings: { bundle: "team" },
		});
		expect(revoked.text()).toContain(REMOTE_MCP_MESSAGES.revoked("team"));
		expect(await grants.grant(bundle.id, "111")).toBeUndefined();
	});

	test("replacing a bundle's URL asks first, then the old URL stops working", async () => {
		const run = await grantCommands();
		const { grants, bundle } = await seedBundle("rotate", "hash-old");
		const asked = await run({
			group: "mcp",
			sub: "token",
			guild: true,
			strings: { bundle: "rotate" },
		});
		expect(asked.text()).toContain(REMOTE_MCP_MESSAGES.rotateAsk("rotate"));
		const [confirm, cancel] = asked.customIds();
		expect(confirm).toStartWith("rtmcp:grant:rotate:");

		// Someone else pressing the button gets nothing.
		const stranger = await run({
			group: "mcp",
			sub: "",
			button: confirm,
			user: "other",
		});
		expect(stranger.text()).toContain(REMOTE_MCP_MESSAGES.expiredTitle);
		expect((await grants.bundleByTokenHash("hash-old"))?.id).toBe(bundle.id);

		const done = await run({ group: "mcp", sub: "", button: confirm });
		expect(done.text()).toContain(REMOTE_MCP_MESSAGES.rotatedTitle);
		expect(done.text()).toContain(`${PUBLIC_URL}/mcp/discord/`);
		expect(await grants.bundleByTokenHash("hash-old")).toBeUndefined();

		// The pending choice is consumed: pressing again, or cancelling, finds it gone.
		const again = await run({ group: "mcp", sub: "", button: cancel });
		expect(again.text()).toContain(REMOTE_MCP_MESSAGES.expiredTitle);
	});

	test("cancelling a pending replacement changes nothing", async () => {
		const run = await grantCommands();
		const { grants, bundle } = await seedBundle("keep", "hash-keep");
		const asked = await run({
			group: "mcp",
			sub: "token",
			guild: true,
			strings: { bundle: "keep" },
		});
		const cancel = asked.customIds()[1];
		const cancelled = await run({ group: "mcp", sub: "", button: cancel });
		expect(cancelled.text()).toContain(REMOTE_MCP_MESSAGES.cancelledTitle);
		expect((await grants.bundleByTokenHash("hash-keep"))?.id).toBe(bundle.id);
	});

	test("the two not-in-bundle refusals and the two name options have their own wording", async () => {
		const messages = {
			notInBundle: () => "DESCRIBE-MISSING",
			revokeNotInBundle: () => "REVOKE-MISSING",
			agentNameOption: "AUTHORIZE-NAME",
			describeAgentNameOption: "DESCRIBE-NAME",
		};
		const { discord } = await boot({ ...base, messages });
		const group = discord
			.compose()
			.commands.find((command) => command.name === "roundtable")
			?.options?.find((option) => option.name === "mcp") as unknown as {
			options: {
				name: string;
				options: { name: string; description: string }[];
			}[];
		};
		const nameOf = (sub: string) =>
			group.options
				.find((option) => option.name === sub)
				?.options.find((option) => option.name === "name")?.description;
		expect(nameOf("authorize")).toBe("AUTHORIZE-NAME");
		expect(nameOf("describe")).toBe("DESCRIBE-NAME");

		const run = await grantCommands(messages);
		await seedBundle("words", "hash-words");
		const strings = { bundle: "words", channel_id: "222", description: "x" };
		const described = await run({
			group: "mcp",
			sub: "describe",
			guild: true,
			strings,
		});
		expect(described.text()).toContain("DESCRIBE-MISSING");
		const revoked = await run({
			group: "mcp",
			sub: "revoke",
			guild: true,
			strings,
		});
		expect(revoked.text()).toContain("REVOKE-MISSING");
	});

	test("the grants list takes the host's label separator, list separator and audit status", async () => {
		const run = await grantCommands({
			labelSeparator: " | ",
			listSeparator: " + ",
			auditStatus: (status) => `<${status}>`,
		});
		const { grants, bundle } = await seedBundle("labels", "hash-labels");
		await grants.save({
			bundleId: bundle.id,
			channelId: "111",
			guildId: "900",
			operations: ["read", "send"],
			displayName: "Lobby",
			description: "",
			guildName: "Example Server",
			channelName: "lobby",
			authorizedBy: "100000000000000001",
			authorizedAt: new Date(),
		});
		const text = (
			await run({ group: "mcp", sub: "grants", guild: true })
		).text();
		expect(text).toContain("- **Lobby** | Example Server › #lobby");
		expect(text).toMatch(/Allowed: .+ \+ .+ \(ID 111\)/);
		expect(text).toContain("`authorize` <succeeded>");
	});
});
