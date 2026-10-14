import { describe, expect, test } from "bun:test";
import {
	ChannelType,
	type Client,
	DiscordAPIError,
	MessageFlags,
} from "discord.js";
import { silentLogger } from "../log.ts";
import { DiscordDashboard } from "./agent-discord.ts";

const BOT = "900";

/** A dashboard channel in a fake server whose one bot message may already be pinned. */
function fixture(options: {
	pinned: boolean;
	pinFails?: boolean;
	editError?: unknown;
	/** The newest message is the "pinned a message" notice Discord posts in the bot's name. */
	pinNotice?: boolean;
}) {
	const pins: string[] = [];
	const edits: Record<string, unknown>[] = [];
	const sends: Record<string, unknown>[] = [];
	const deletes: string[] = [];
	const message = {
		id: "m1",
		pinned: options.pinned,
		system: false,
		author: { id: BOT },
		channel: { messages: { fetch: async () => message } },
		edit: async (body: Record<string, unknown>) => {
			edits.push(body);
			if (options.editError) throw options.editError;
			return message;
		},
		delete: async () => {
			deletes.push("m1");
		},
		pin: async () => {
			if (options.pinFails) throw new Error("Missing Permissions");
			pins.push("m1");
		},
	};
	const channel = {
		type: ChannelType.GuildText,
		name: "dashboard",
		parentId: null,
		topic: null,
		setTopic: async () => undefined,
		send: async (body: Record<string, unknown>) => {
			sends.push(body);
			return { ...message, id: "m2" };
		},
		messages: {
			fetch: async () => ({
				find: (match: (m: typeof message) => boolean) =>
					[
						...(options.pinNotice
							? [
									{
										...message,
										id: "s1",
										system: true,
										pinned: false,
										edit: async () => {
											throw new DiscordAPIError(
												{
													code: 50021,
													message: "Cannot execute action on a system message",
												},
												50021,
												400,
												"PATCH",
												"/channels/1/messages/s1",
												{},
											);
										},
									},
								]
							: []),
						message,
					].find(match),
			}),
		},
	};
	channel.topic = null;
	const client = {
		user: { id: BOT },
		guilds: {
			fetch: async () => ({
				channels: {
					fetch: async () => ({
						find: (match: (c: typeof channel) => boolean) =>
							[channel].find(match),
					}),
				},
			}),
		},
	} as unknown as Client;
	return {
		pins,
		edits,
		sends,
		deletes,
		dashboard: new DiscordDashboard(client, "1", silentLogger()),
	};
}

describe("DiscordDashboard pinning", () => {
	test("an existing unpinned message is pinned once, however often it is updated", async () => {
		const { dashboard, pins } = fixture({ pinned: false });
		await dashboard.show(["a"]);
		await dashboard.show(["b"]);
		expect(pins).toEqual(["m1"]);
	});

	test("an already pinned message is left alone", async () => {
		const { dashboard, pins } = fixture({ pinned: true });
		await dashboard.show(["a"]);
		expect(pins).toEqual([]);
	});

	test("a refused pin does not stop the update", async () => {
		const { dashboard } = fixture({ pinned: false, pinFails: true });
		await dashboard.show(["a"]);
		await dashboard.show(["b"]);
	});
});

describe("DiscordDashboard editing", () => {
	const invalidForm = () =>
		new DiscordAPIError(
			{ code: 50035, message: "Invalid Form Body" },
			50035,
			400,
			"PATCH",
			"/channels/1/messages/m1",
			{},
		);

	test("an edit keeps the components v2 flag", async () => {
		const { dashboard, edits, sends } = fixture({ pinned: true });
		await dashboard.show(["a"]);
		expect(edits).toHaveLength(1);
		expect(edits[0]?.flags).toBe(MessageFlags.IsComponentsV2);
		expect(sends).toHaveLength(0);
	});

	test("a message refused as invalid form body is deleted and posted fresh once", async () => {
		const { dashboard, edits, sends, deletes } = fixture({
			pinned: true,
			editError: invalidForm(),
		});
		await dashboard.show(["a"]);
		expect(edits).toHaveLength(1);
		expect(deletes).toEqual(["m1"]);
		expect(sends).toHaveLength(1);
		expect(sends[0]?.flags).toBe(MessageFlags.IsComponentsV2);
	});

	test("the pin notice Discord posts in the bot's name is passed over", async () => {
		const { dashboard, edits, sends, deletes } = fixture({
			pinned: true,
			pinNotice: true,
		});
		await dashboard.show(["a"]);
		expect(edits).toHaveLength(1);
		expect(deletes).toEqual([]);
		expect(sends).toHaveLength(0);
	});

	test("any other edit failure is thrown and nothing is deleted or posted", async () => {
		const { dashboard, sends, deletes } = fixture({
			pinned: true,
			editError: new Error("boom"),
		});
		await expect(dashboard.show(["a"])).rejects.toThrow("boom");
		expect(deletes).toEqual([]);
		expect(sends).toHaveLength(0);
	});
});
