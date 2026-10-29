import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type ChannelKey,
	definePlugin,
	IDENTITY,
	type InboundMessage,
	type Speaker,
} from "pi-roundtable";
import { servicePair, testPlugin } from "pi-roundtable/testing";
import { SandboxChannelStore } from "./channel-store.ts";
import { type SandboxReplyText, sandboxClaim } from "./claim.ts";

const GUILD = "900000000000000001";

const served = servicePair(IDENTITY, {
	resolve: async (facts) =>
		facts.subject === "alice"
			? ({
					id: "alice",
					name: "Alice",
					tier: "member",
					principalId: "p_alice",
				} as Speaker)
			: undefined,
});

const message: InboundMessage = {
	channel: "discord:900",
	messageId: "one",
	authorId: "alice",
	authorName: "Alice",
	authorIsBot: false,
	isDirect: false,
	mentionsBot: true,
	repliesToBot: false,
	text: "Hello",
	attachments: [],
	space: GUILD,
};

async function harness(
	reply: { ok: boolean; text: string },
	replyText?: SandboxReplyText,
) {
	const root = mkdtempSync(join(tmpdir(), "sb-reply-text-"));
	const channels = new SandboxChannelStore(join(root, "c.json"), [], {
		guilds: [GUILD],
	});
	const replies: string[] = [];
	const failures: ChannelKey[] = [];
	const errors: unknown[] = [];
	const host = await testPlugin(
		definePlugin({
			name: "reply-text-claim",
			setup: (context) => ({
				channels: [
					sandboxClaim({
						channels,
						runtime: {
							runTurn: async () => reply,
							stop: () => true,
							startFresh: () => {},
						},
						surfaces: context.surfaces,
						reportFailure: (channel, error) => {
							failures.push(channel);
							errors.push(error);
						},
						...(replyText ? { replyText } : {}),
					}),
				],
			}),
		}),
		{
			services: [served],
			surfaces: [
				{
					surface: "discord",
					start: async () => {},
					sendReply: async (_channel, sent) => {
						replies.push(...sent.chunks);
					},
				},
			],
		},
	);
	return {
		host,
		replies,
		failures,
		errors,
		done: async () => {
			await host.stop();
			rmSync(root, { recursive: true, force: true });
		},
	};
}

test("replyText rewrites a successful reply before it is posted, with the channel and its guild", async () => {
	const seen: unknown[] = [];
	const run = await harness(
		{ ok: true, text: "abc" },
		async (text, context) => {
			seen.push({ text, context });
			return text.toUpperCase();
		},
	);
	try {
		await run.host.conversations.handle(message);
		expect(run.replies).toEqual(["ABC"]);
		expect(seen).toEqual([
			{ text: "abc", context: { channel: "discord:900", space: GUILD } },
		]);
		expect(run.failures).toEqual([]);
	} finally {
		await run.done();
	}
});

test("without replyText the reply is posted as the model wrote it", async () => {
	const run = await harness({ ok: true, text: "as written" });
	try {
		await run.host.conversations.handle(message);
		expect(run.replies).toEqual(["as written"]);
	} finally {
		await run.done();
	}
});

test("a failed turn's text never passes through replyText", async () => {
	const calls: string[] = [];
	const run = await harness({ ok: false, text: "ignored" }, (text) => {
		calls.push(text);
		return text;
	});
	try {
		await run.host.conversations.handle(message);
		expect(calls).toEqual([]);
		expect(run.replies).toEqual(["The sandbox turn failed."]);
	} finally {
		await run.done();
	}
});

test("a replyText that throws or returns no string fails the turn and is reported", async () => {
	for (const replyText of [
		() => {
			throw new Error("boom");
		},
		() => 42 as unknown as string,
	]) {
		const run = await harness({ ok: true, text: "abc" }, replyText);
		try {
			await run.host.conversations.handle(message);
			expect(run.replies).toEqual(["The sandbox turn failed or was stopped."]);
			expect(run.failures).toEqual(["discord:900"]);
			expect(run.errors[0]).toBeInstanceOf(Error);
		} finally {
			await run.done();
		}
	}
});
