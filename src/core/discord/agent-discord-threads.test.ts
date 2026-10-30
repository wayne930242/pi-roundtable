import { expect, test } from "bun:test";
import {
	ChannelType,
	type Client,
	type WebhookMessageCreateOptions,
} from "discord.js";
import { DiscordAgentChannels } from "./agent-discord.ts";

/** A client whose channels are a parent text channel `10` and a thread `20` under it. */
function world() {
	const sent: { hook: string; payload: WebhookMessageCreateOptions }[] = [];
	const edits: Record<string, unknown>[] = [];
	const hookEdits: Record<string, unknown>[] = [];
	const created: Record<string, unknown>[] = [];
	const archived: boolean[] = [];
	const hooks = new Set<string>();
	const hook = (channel: string) => ({
		name: "agents",
		applicationId: "app",
		send: async (payload: WebhookMessageCreateOptions) => {
			sent.push({ hook: channel, payload });
			return { id: "m1" };
		},
		editMessage: async (_message: unknown, body: Record<string, unknown>) => {
			hookEdits.push(body);
		},
	});
	const parent = {
		id: "10",
		type: ChannelType.GuildText,
		isThread: () => false,
		fetchWebhooks: async () => ({
			find: (match: (w: ReturnType<typeof hook>) => boolean) =>
				[hook("10")].find(match),
		}),
		createWebhook: async () => {
			hooks.add("10");
			return hook("10");
		},
		threads: {
			create: async (options: Record<string, unknown>) => {
				created.push(options);
				return { id: "20" };
			},
		},
	};
	const thread = {
		id: "20",
		type: ChannelType.PublicThread,
		parentId: "10",
		isThread: () => true,
		edit: async (change: Record<string, unknown>) => {
			edits.push(change);
		},
		setArchived: async (value: boolean) => {
			archived.push(value);
		},
	};
	const client = {
		application: { id: "app" },
		channels: {
			fetch: async (id: string) =>
				id === "10" ? parent : id === "20" ? thread : null,
		},
	} as unknown as Client;
	return {
		channels: new DiscordAgentChannels(client, "guild"),
		sent,
		edits,
		hookEdits,
		created,
		archived,
		thread,
	};
}

const AS = { name: "Scout", avatarUrl: "https://example.com/a.png" };

test("a thread under a channel is opened for a temp knight, and its posts go through the parent's webhook into it", async () => {
	const w = world();
	const id = await w.channels.createThread("10", "Scout One");
	expect(id).toBe("20");
	expect(w.created[0]).toMatchObject({ name: "Scout One" });
	await w.channels.post("20", { ...AS, chunks: ["Done."] });
	expect(w.sent).toHaveLength(1);
	expect(w.sent[0]?.hook).toBe("10");
	expect(w.sent[0]?.payload).toMatchObject({
		username: "Scout",
		content: "Done.",
		threadId: "20",
	});
});

test("a post to a thread found by its id alone is routed the same way, and a plain channel posts in place", async () => {
	const w = world();
	await w.channels.post("20", { ...AS, chunks: ["a"] });
	await w.channels.post("10", { ...AS, chunks: ["b"] });
	expect(w.sent.map((s) => [s.hook, s.payload.threadId])).toEqual([
		["10", "20"],
		["10", undefined],
	]);
	const interim = await w.channels.interim("20", AS).post("working");
	await interim.edit("done");
	expect(w.sent[2]?.payload).toMatchObject({
		content: "working",
		threadId: "20",
	});
	expect(w.hookEdits).toEqual([{ content: "done", threadId: "20" }]);
});

test("closing a thread archives and locks it, and opening it again unarchives and unlocks it", async () => {
	const w = world();
	await w.channels.closeThread("20");
	await w.channels.openThread("20");
	expect(w.edits).toEqual([
		{ archived: true, locked: true },
		{ archived: false, locked: false },
	]);
});

test("without permission to lock, the thread is only archived, and unarchived again", async () => {
	const w = world();
	w.thread.edit = async () => {
		throw new Error("Missing Permissions");
	};
	await w.channels.closeThread("20");
	await w.channels.openThread("20");
	expect(w.archived).toEqual([true, false]);
});

test("a channel that is no thread is refused as one", async () => {
	const w = world();
	await expect(w.channels.closeThread("10")).rejects.toThrow("not a thread");
});
