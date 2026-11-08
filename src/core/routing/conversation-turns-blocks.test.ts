import { describe, expect, test } from "bun:test";
import { DISPLAY_KINDS } from "pi-better-show";
import type { AgentRuntime } from "../contract/runtime.ts";
import type { ChatSurface, SurfacePort } from "../contract/surface.ts";
import type { ChannelKey, OutboundReply } from "../domain/conversation.ts";
import { silentLogger } from "../kernel/log.ts";
import {
	ALL_BLOCKS_REPLY,
	BLOCK_SAMPLES,
	fencesIn,
} from "../testing/fixtures/all-blocks.ts";
import { OWNER_SPEAKER } from "../testing/owner.ts";
import { conversationTurns } from "./conversation-turns.ts";

/** A turn that answers `text` in `channel`, and what the surface of that channel was sent. */
async function replyTo(
	channel: ChannelKey,
	surface: Pick<ChatSurface, "surface" | "blocks" | "blockText" | "support">,
	text: string,
	lang?: SurfacePort["lang"],
): Promise<OutboundReply[]> {
	const replies: OutboundReply[] = [];
	const surfaces = {
		...(lang ? { lang } : {}),
		of: (key: ChannelKey) =>
			key.startsWith(`${surface.surface}:`)
				? (surface as ChatSurface)
				: undefined,
		sendReply: async (_channel: ChannelKey, reply: OutboundReply) => {
			replies.push(reply);
		},
		startTyping: () => () => undefined,
		showStop: () => () => undefined,
		interim: () => undefined,
		progress: async () => undefined,
	} as unknown as SurfacePort;
	const turns = conversationTurns({
		linked: () => undefined,
		runtime: () =>
			({
				runTurn: async () => ({ ok: true, text }),
			}) as unknown as AgentRuntime,
		surfaces,
		events: {
			turnStarted: () => undefined,
			turnEnded: () => undefined,
			changed: () => undefined,
		},
		selection: () => ({ tools: [], groups: [] }),
		logger: silentLogger(),
	});
	await turns.run({
		channel,
		kind: "study",
		text: "show me",
		speaker: OWNER_SPEAKER,
	});
	return replies;
}

const tableOf = (rows: number) =>
	[
		"```table",
		"columns: [name, size]",
		"rows:",
		...Array.from(
			{ length: rows },
			(_, i) => `  - [row ${i} of the table, ${i}]`,
		),
		"```",
	].join("\n");

describe("a turn's reply on a surface", () => {
	test("a 5000-character table reaches a surface that draws tables as one chunk", async () => {
		const table = tableOf(260);
		expect(table.length).toBeGreaterThan(5000);
		const text = `Here is the data.\n\n${table}`;
		const [reply, ...more] = await replyTo(
			"app:room",
			{ surface: "app", blocks: DISPLAY_KINDS },
			text,
		);
		expect(more).toEqual([]);
		expect(reply?.chunks).toEqual([text]);
	});

	test("the same table reaches a surface that draws none as a short text, not as YAML", async () => {
		const [reply] = await replyTo(
			"discord:1",
			{ surface: "discord" },
			`Here is the data.\n\n${tableOf(260)}`,
		);
		const text = reply?.chunks.join("\n") ?? "";
		expect(text).toContain("• name: row 0 of the table · size: 0");
		expect(text).toContain("more rows");
		for (const chunk of reply?.chunks ?? []) {
			expect(chunk.length).toBeLessThanOrEqual(2000);
			expect(chunk).not.toContain("```");
		}
	});

	test("a reply with every kind of block leaves no block fence on a surface of the chat networks, but Discord's diff", async () => {
		const [discord] = await replyTo(
			"discord:1",
			{ surface: "discord" },
			ALL_BLOCKS_REPLY,
		);
		expect(fencesIn(discord?.chunks.join("\n") ?? "")).toEqual(["diff"]);
		const [line] = await replyTo(
			"line:1",
			{ surface: "line", blockText: "line" },
			ALL_BLOCKS_REPLY,
		);
		expect(line?.chunks.join("\n")).not.toContain("```");
		expect(line?.chunks.join("\n")).not.toContain("**");
	});

	test("a channel no surface serves gets the reply as Discord does", async () => {
		const [reply] = await replyTo(
			"nobody:1",
			{ surface: "app", blocks: DISPLAY_KINDS },
			ALL_BLOCKS_REPLY,
		);
		expect(fencesIn(reply?.chunks.join("\n") ?? "")).toEqual(["diff"]);
	});

	test("a channel the surface says differs gets no block fence, though the surface draws blocks", async () => {
		const [reply] = await replyTo(
			"app:host.1",
			{
				surface: "app",
				blocks: DISPLAY_KINDS,
				support: (channel) =>
					channel === "app:host.1" ? { blocks: [] } : undefined,
			},
			ALL_BLOCKS_REPLY,
		);
		expect(fencesIn(reply?.chunks.join("\n") ?? "")).toEqual(["diff"]);
	});

	test("an interactive block reaches Discord as the question to answer by typing, in the host's language", async () => {
		const text = `Pick one.\n\n${BLOCK_SAMPLES.options}`;
		const [english] = await replyTo("discord:1", { surface: "discord" }, text);
		expect(english?.chunks.join("\n")).toContain("Reply with a number.");
		const [chinese] = await replyTo(
			"discord:1",
			{ surface: "discord" },
			text,
			"zh-TW",
		);
		const asked = chinese?.chunks.join("\n") ?? "";
		expect(asked).toContain("\u8acb\u56de\u8986\u7de8\u865f\u3002");
		expect(asked).not.toContain("```options");
	});
});
