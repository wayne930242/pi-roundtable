import { describe, expect, test } from "bun:test";
import { ChannelType, type Client } from "discord.js";
import { messages } from "../i18n/index.ts";
import { DiscordThreadHost } from "./dispatch-thread-host.ts";

class FakeThread {
	readonly sent: string[] = [];
	readonly edits: unknown[] = [];
	archived = false;
	failEdit = false;
	constructor(readonly id: string) {}
	isThread() {
		return true;
	}
	async send({ content }: { content: string }) {
		this.sent.push(content);
	}
	async edit(change: unknown) {
		if (this.failEdit) throw new Error("Missing Permissions");
		this.edits.push(change);
	}
	async setArchived(archived: boolean) {
		this.archived = archived;
	}
}

class FakeStartMessage {
	deleted = false;
	thread: { name: string; autoArchiveDuration: number } | undefined;
	constructor(
		public content: string,
		readonly failThread: boolean,
	) {}
	async startThread(options: { name: string; autoArchiveDuration: number }) {
		if (this.failThread) throw new Error("Missing Permissions");
		this.thread = options;
		return { id: "700" };
	}
	async edit({ content }: { content: string }) {
		this.content = content;
	}
	async delete() {
		this.deleted = true;
	}
}

class FakeParent {
	readonly messages: FakeStartMessage[] = [];
	failThread = false;
	constructor(readonly type: ChannelType) {}
	isThread() {
		return false;
	}
	isSendable() {
		return true;
	}
	async send({ content }: { content: string }) {
		const message = new FakeStartMessage(content, this.failThread);
		this.messages.push(message);
		return message;
	}
}

function setup() {
	const channels = new Map<string, unknown>([
		["10", new FakeParent(ChannelType.GuildText)],
		["11", new FakeParent(ChannelType.DM)],
		["12", new FakeParent(ChannelType.PublicThread)],
		["700", new FakeThread("700")],
	]);
	const client = {
		channels: { fetch: async (id: string) => channels.get(id) ?? null },
	} as unknown as Client;
	return {
		host: new DiscordThreadHost(client),
		parent: (id: string) => channels.get(id) as FakeParent,
		thread: channels.get("700") as FakeThread,
	};
}

const line = (thread?: string) => messages().threadStarted("t", thread);

describe("DiscordThreadHost", () => {
	test("starts the thread from the start line, then links it there", async () => {
		const { host, parent } = setup();
		expect(await host.open("10", "repo #1", line)).toBe("700");
		const [start] = parent("10").messages;
		expect(start?.thread?.name).toBe("repo #1");
		expect(start?.content).toBe(messages().threadStarted("t", "<#700>"));
	});

	test("DMs and threads cannot host one; a refused thread removes its start line", async () => {
		const { host, parent } = setup();
		expect(await host.open("11", "t", line)).toBeUndefined();
		expect(await host.open("12", "t", line)).toBeUndefined();
		expect(await host.open("99", "t", line).catch(() => "threw")).toBe(
			undefined,
		);
		parent("10").failThread = true;
		expect(await host.open("10", "t", line).catch(() => "threw")).toBe("threw");
		expect(parent("10").messages[0]?.deleted).toBe(true);
	});

	test("posts in the thread, then archives and locks it, or only archives without the permission", async () => {
		const { host, thread } = setup();
		await host.post("700", "report");
		expect(thread.sent).toEqual(["report"]);
		await host.close("700");
		expect(thread.edits).toEqual([{ archived: true, locked: true }]);
		thread.failEdit = true;
		await host.close("700");
		expect(thread.archived).toBe(true);
	});
});
