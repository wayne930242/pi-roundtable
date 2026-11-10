import { expect, test } from "bun:test";
import { ChannelType, Client, GatewayIntentBits } from "discord.js";
import type { AgentChannels } from "../agents/agent-ports.ts";
import { channelKey } from "../contract/surface.ts";
import { silentLogger } from "../kernel/log.ts";
import { DiscordEmulator } from "../testing/discord-api-emulator.ts";
import { BOT_ID, BOT_TOKEN } from "../testing/discord-api-emulator-state.ts";
import { placeProviderContract } from "../testing/place-contract.ts";
import { recordingLogger } from "../testing/recording-logger.ts";
import { DiscordAgentChannels } from "./agent-discord.ts";
import { discordPlaces } from "./agent-places.ts";

const GUILD = "900000000000000001";
const ELSEWHERE = "900000000000000002";
const OWNER = "900000000000000003";

/** The agent guild and another server in the emulated Discord, and a client that talks to it. */
async function world(
	logger = silentLogger(),
	override: Partial<AgentChannels> = {},
) {
	const emulator = new DiscordEmulator();
	emulator.token = BOT_TOKEN;
	emulator.start();
	emulator.addGuild(GUILD, OWNER);
	emulator.addGuild(ELSEWHERE, OWNER);
	const client = new Client({ intents: [GatewayIntentBits.Guilds] });
	(client.rest.options as { api: string }).api = emulator.api;
	client.rest.setToken(BOT_TOKEN);
	// A failed request is the test's to see, not to retry.
	(client.rest.options as { retries: number }).retries = 0;
	// The bot's application id is known once the gateway is ready; the webhooks are found by it.
	(client as unknown as { application: { id: string } }).application = {
		id: BOT_ID,
	};
	await client.guilds.fetch(GUILD);
	const listeners: ((id: string) => void)[] = [];
	const real = new DiscordAgentChannels(client, GUILD);
	const channels = new Proxy(real, {
		get: (target, property: string) => {
			if (property in override)
				return override[property as keyof AgentChannels];
			const member = (target as unknown as Record<string, unknown>)[property];
			return typeof member === "function" ? member.bind(target) : member;
		},
	});
	const provider = discordPlaces({
		client,
		guild: GUILD,
		channels,
		onRemoved: (listener) => void listeners.push(listener),
		logger,
	});
	return {
		emulator,
		client,
		provider,
		channels,
		/** A person deletes the channel; the gateway would tell the listeners. */
		delete: async (id: string) => {
			await client.rest.delete(`/channels/${id}`);
			// The gateway's channel delete drops the client's copy and tells the listeners.
			client.channels.cache.delete(id);
			for (const listener of listeners) listener(id);
		},
		/** What a person reading the channel has seen: the webhook's posts, under the name they spoke as. */
		seen: (id: string) =>
			(emulator.state.channels.get(id)?.messages ?? []).map((message) => ({
				author: message.username ?? "",
				text: message.content,
			})),
		close: async () => {
			client.removeAllListeners();
			emulator.stop();
		},
	};
}

const idOf = (key: string) => key.slice(key.indexOf(":") + 1);

placeProviderContract(
	"Discord's provider over the emulated Discord",
	async () => {
		const w = await world();
		return {
			provider: w.provider,
			seen: (key) => w.seen(idOf(key)),
			delete: w.delete,
			foreign: async () => {
				w.emulator.addChannel("900000000000000099", ELSEWHERE, {
					name: "elsewhere",
				});
				return "900000000000000099";
			},
			close: w.close,
		};
	},
);

test("an agent's channel opens under Agents, a group's under Groups, and a hint names the category", async () => {
	const w = await world();
	try {
		const agent = await w.provider.ensure?.({
			kind: "agent",
			name: "knight",
			displayName: "Sir Knight",
			topic: "Sir Knight",
		});
		const group = await w.provider.ensure?.({
			kind: "group",
			name: "table",
			displayName: "Table",
			topic: "Knight and Scribe",
			hints: { category: "Groups-work" },
		});
		const named = (id: string | undefined) => {
			const channel = w.emulator.state.channels.get(id ?? "");
			return {
				name: channel?.name,
				topic: channel?.topic,
				category: w.emulator.state.channels.get(channel?.parentId ?? "")?.name,
			};
		};
		expect(named(agent)).toEqual({
			name: "knight",
			topic: "Sir Knight",
			category: "Agents",
		});
		expect(named(group)).toEqual({
			name: "table",
			topic: "Knight and Scribe",
			category: "Groups-work",
		});
		await expect(
			w.provider.ensure?.({
				kind: "agent",
				name: "other",
				displayName: "Other",
				topic: "Other",
				hints: { category: "Groups" },
			}),
		).rejects.toThrow("holds groups");
	} finally {
		await w.close();
	}
});

test("ensure with existing leaves a channel under a category of its kind and moves one that is elsewhere", async () => {
	const w = await world();
	try {
		const spec = {
			kind: "group" as const,
			name: "table",
			displayName: "Table",
			topic: "Knight and Scribe",
		};
		const id = (await w.provider.ensure?.({
			...spec,
			hints: { category: "Groups-work" },
		})) as string;
		const parent = () =>
			w.emulator.state.channels.get(
				w.emulator.state.channels.get(id)?.parentId ?? "",
			)?.name;
		expect(await w.provider.ensure?.({ ...spec, existing: id })).toBe(id);
		expect(parent()).toBe("Groups-work");
		// Out of its kind's categories, it goes under the plain one; a named category is honoured.
		await w.channels.placeIn(id, "Agents-work");
		expect(await w.provider.ensure?.({ ...spec, existing: id })).toBe(id);
		expect(parent()).toBe("Groups");
		await w.provider.ensure?.({
			...spec,
			existing: id,
			hints: { category: "Groups-late" },
		});
		expect(parent()).toBe("Groups-late");
	} finally {
		await w.close();
	}
});

test("remove moves the channel to Archive and takes its webhook; ensure with existing puts it back", async () => {
	const w = await world();
	try {
		const spec = {
			kind: "agent" as const,
			name: "knight",
			displayName: "Sir Knight",
			topic: "Sir Knight",
		};
		const id = (await w.provider.ensure?.(spec)) as string;
		await w.provider.post(channelKey("discord", id), {
			author: { name: "Sir Knight", avatarUrl: "https://example.test/a.png" },
			chunks: ["hello"],
		});
		expect(w.emulator.state.webhooks.size).toBe(1);
		const line = await w.provider.remove?.(id, { ...spec, helper: false });
		const parent = () =>
			w.emulator.state.channels.get(
				w.emulator.state.channels.get(id)?.parentId ?? "",
			)?.name;
		expect(line).toBe(`; its channel <#${id}> is kept under Archive.`);
		expect(parent()).toBe("Archive");
		expect(w.emulator.state.webhooks.size).toBe(0);
		expect(await w.provider.ensure?.({ ...spec, existing: id })).toBe(id);
		expect(parent()).toBe("Agents");
	} finally {
		await w.close();
	}
});

test("a temp knight's place is a thread of its parent's channel, closed by remove and reopened by ensure", async () => {
	const w = await world();
	try {
		const parent = (await w.provider.ensure?.({
			kind: "agent",
			name: "knight",
			displayName: "Sir Knight",
			topic: "Sir Knight",
		})) as string;
		const spec = {
			kind: "agent" as const,
			name: "squire",
			displayName: "Squire",
			topic: "Squire",
			parent,
		};
		const thread = (await w.provider.ensure?.(spec)) as string;
		const found = w.emulator.state.channels.get(thread);
		expect(found?.type).toBe(ChannelType.PublicThread);
		expect(found?.parentId).toBe(parent);
		// It speaks through the parent's webhook, into the thread.
		await w.provider.post(channelKey("discord", thread), {
			author: { name: "Squire", avatarUrl: "https://example.test/s.png" },
			chunks: ["at your service"],
		});
		expect(w.seen(thread)).toEqual([
			{ author: "Squire", text: "at your service" },
		]);
		expect(w.seen(parent)).toEqual([]);
		expect(await w.provider.remove?.(thread, { ...spec, helper: true })).toBe(
			undefined,
		);
		expect(found?.thread?.archived).toBe(true);
		expect(await w.provider.ensure?.({ ...spec, existing: thread })).toBe(
			thread,
		);
		expect(found?.thread?.archived).toBe(false);
		// A thread that is gone is made again.
		await w.delete(thread);
		const again = await w.provider.ensure?.({ ...spec, existing: thread });
		expect(again).not.toBe(thread);
	} finally {
		await w.close();
	}
});

test("check: ok in the agent guild, gone once deleted, foreign in another server", async () => {
	const w = await world();
	try {
		w.emulator.addChannel("900000000000000050", GUILD, { name: "mine" });
		w.emulator.addChannel("900000000000000051", ELSEWHERE, { name: "theirs" });
		expect(await w.provider.check?.("900000000000000050")).toBe("ok");
		expect(await w.provider.check?.("900000000000000051")).toBe("foreign");
		expect(await w.provider.check?.("900000000000000077")).toBe("gone");
		w.emulator.state.channels.delete("900000000000000050");
		expect(await w.provider.check?.("900000000000000050")).toBe("gone");
	} finally {
		await w.close();
	}
});

test("check does not call a channel the bot cannot see foreign or gone: Missing Access also answers a hidden channel of its own guild", async () => {
	const w = await world();
	try {
		w.emulator.addChannel("900000000000000050", GUILD, { name: "mine" });
		w.emulator.hideChannel("900000000000000050");
		await expect(w.provider.check?.("900000000000000050")).rejects.toThrow(
			"Missing Access",
		);
	} finally {
		await w.close();
	}
});

test("check does not call a place gone on an error that says nothing of it", async () => {
	const w = await world();
	try {
		w.emulator.addChannel("900000000000000050", GUILD, { name: "mine" });
		w.emulator.failNext(1);
		await expect(w.provider.check?.("900000000000000050")).rejects.toThrow();
	} finally {
		await w.close();
	}
});

test("keys, a group's seats and log, and mentions keep the forms they had", async () => {
	const w = await world();
	try {
		const { provider } = w;
		expect(provider.key({ kind: "agent", name: "knight" }, "123")).toBe(
			"discord:123",
		);
		expect(provider.placeOf("discord:123")).toEqual({ id: "123" });
		expect(provider.placeOf("app:agent.knight")).toBeUndefined();
		expect(() => provider.key({ kind: "agent", name: "knight" })).toThrow(
			"keyed by its channel id",
		);
		expect(provider.conversations?.seat("456", "knight")).toBe(
			"agentgroup:456.knight",
		);
		expect(provider.conversations?.log("table")).toBe("table");
		expect(provider.mention?.("discord:123")).toBe("<#123>");
		expect(provider.space).toBe(GUILD);
		expect(provider.storage).toBe("stored");
	} finally {
		await w.close();
	}
});

test("the category argument of the creation tools is Discord's, and the layout lists the team's categories", async () => {
	const w = await world();
	try {
		expect(Object.keys(w.provider.createArguments?.agent ?? {})).toEqual([
			"category",
		]);
		expect(Object.keys(w.provider.createArguments?.group ?? {})).toEqual([
			"category",
		]);
		const id = (await w.provider.ensure?.({
			kind: "agent",
			name: "knight",
			displayName: "Sir Knight",
			topic: "Sir Knight",
		})) as string;
		w.emulator.addChannel("900000000000000060", GUILD, {
			type: 4,
			name: "Notes",
		});
		expect(await w.provider.layoutText?.()).toBe(
			`Categories, in server order:\n- Agents: <#${id}>`,
		);
	} finally {
		await w.close();
	}
});

test("a webhook that cannot be removed does not stop the archive, and a channel that cannot be moved says so", async () => {
	const { logger, lines } = recordingLogger();
	const denied = async () => {
		throw new Error("Missing Permissions");
	};
	const w = await world(logger, { removeWebhook: denied });
	const failing = await world(logger, {
		removeWebhook: denied,
		placeIn: denied,
	});
	try {
		const spec = {
			kind: "agent" as const,
			name: "knight",
			displayName: "Sir Knight",
			topic: "Sir Knight",
		};
		const id = (await w.provider.ensure?.(spec)) as string;
		expect(await w.provider.remove?.(id, { ...spec, helper: false })).toBe(
			`; its channel <#${id}> is kept under Archive.`,
		);
		const line = await failing.provider.remove?.("123", {
			...spec,
			helper: false,
		});
		expect(line).toBe(
			", but its channel <#123> could not be moved to Archive (Missing Permissions); it stays silent where it is.",
		);
		expect(lines.map((l) => `${l.level}: ${l.message}`)).toEqual([
			"warn: archived channel's webhook not removed",
			"warn: archived channel's webhook not removed",
			"error: archived channel not moved",
		]);
	} finally {
		await w.close();
		await failing.close();
	}
});
