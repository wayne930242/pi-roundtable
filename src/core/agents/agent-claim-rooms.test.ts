import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboundMessage } from "../contract/channels.ts";
import type { ChatSurface } from "../contract/surface.ts";
import { silentLogger } from "../log.ts";
import type { Speaker } from "../speakers.ts";
import { TEST_OWNER } from "../testing/owner.ts";
import { agentClaim } from "./agent-claim.ts";

const OWNER = "100000000000000001";

const message = (
	authorId: string,
	channel: `${string}:${string}`,
	extra: Partial<InboundMessage> = {},
): InboundMessage => ({
	channel,
	messageId: "m1",
	authorId,
	authorName: `name-${authorId.slice(-1)}`,
	authorIsBot: false,
	isDirect: false,
	space: "1",
	mentionsBot: false,
	repliesToBot: false,
	text: "hello",
	attachments: [],
	...extra,
});

// ── Agent rooms on any surface ────────────────────────────────────────────

/** A team that knows `coder` and the group `ops` in rooms, and wrongly claims `other:agent.coder` too. */
function roomsSetup(
	roomSurfaces: readonly string[] = ["app"],
	surfaceExtra: Partial<ChatSurface> = {},
) {
	const answered: { channel: string; kind: string; files: string[] }[] = [];
	const team = {
		guildId: "1",
		owns: (channel: string) =>
			channel === "app:agent.coder" || channel === "other:agent.coder"
				? ("agent" as const)
				: channel === "app:group.ops"
					? ("group" as const)
					: undefined,
		answerOwner: async (
			channel: string,
			_speaker: Speaker,
			_text: string,
			_reply: string,
			carried: { files: readonly { name: string; path: string }[] },
		) => {
			answered.push({
				channel,
				kind: "agent",
				files: carried.files.map((f) => f.name),
			});
			return { ok: true as const, text: "" };
		},
		answerGroup: async (channel: string) => {
			answered.push({ channel, kind: "group", files: [] });
		},
		answerBackground: async (channel: string) => {
			answered.push({ channel, kind: "background", files: [] });
			return { ok: true as const, text: "" };
		},
		startFresh: async () => {},
	};
	const reads: string[] = [];
	const app = {
		surface: "app",
		agentRooms: true,
		readAttachment: async (_channel: string, ref: { url: string }) => {
			reads.push(ref.url);
			return new TextEncoder().encode("from the surface");
		},
		...surfaceExtra,
	};
	const claim = agentClaim({
		owner: TEST_OWNER,
		// biome-ignore lint/suspicious/noExplicitAny: a recording stand-in for the team
		team: team as any,
		runtime: { steer: async () => false, stop: () => true },
		surface: {
			react: async () => {},
			unreact: async () => {},
			roomSurfaces: () => roomSurfaces,
			of: (channel: string) =>
				(channel.startsWith("app:") ? app : undefined) as
					| ChatSurface
					| undefined,
		},
		attachmentDir: () => mkdtempSync(join(tmpdir(), "agent-claim-rooms-")),
		logger: silentLogger(),
		fetchImpl: (() => {
			throw new Error(
				"a surface's own attachment was fetched over the network",
			);
		}) as unknown as typeof fetch,
	});
	return { claim, answered, reads };
}

const ROOM_OWNER = { id: "owner", tier: "owner" } as const;

function roomMessage(
	channel: `${string}:${string}`,
	extra: Partial<InboundMessage> = {},
): InboundMessage {
	return {
		...message(OWNER, channel, extra),
		speaker: {
			id: OWNER,
			name: "Boss",
			tier: ROOM_OWNER.tier,
			principalId: "p_owner",
		},
		space: undefined,
	};
}

test("the claim owns the agent and group rooms of a room surface, and nothing else", () => {
	const { claim } = roomsSetup();
	expect(claim.owns("app:agent.coder", undefined)).toBe(true);
	expect(claim.owns("app:group.ops", undefined)).toBe(true);
	// Unknown names, kinds, and another surface's keys, even when the team would name them.
	expect(claim.owns("app:agent.nobody", undefined)).toBe(false);
	expect(claim.owns("app:thread.x", undefined)).toBe(false);
	expect(claim.owns("other:agent.coder", undefined)).toBe(false);
	// The space of a message never makes a room the agent server's.
	expect(claim.owns("other:agent.nobody", "1")).toBe(false);
	expect(claim.owns("app:agent.nobody", "1")).toBe(false);
});

test("a surface that does not declare agentRooms gets no rooms", () => {
	const { claim } = roomsSetup([]);
	expect(claim.owns("app:agent.coder", undefined)).toBe(false);
});

test("an owner message in a room is answered in that room", async () => {
	const { claim, answered } = roomsSetup();
	const agent = claim.admit(roomMessage("app:agent.coder"));
	if (agent?.kind !== "turn") throw new Error("expected a turn");
	await agent.run();
	const group = claim.admit(roomMessage("app:group.ops"));
	if (group?.kind !== "turn") throw new Error("expected a turn");
	await group.run();
	expect(answered.map((a) => [a.kind, a.channel])).toEqual([
		["agent", "app:agent.coder"],
		["group", "app:group.ops"],
	]);
});

test("an attachment the surface made is read through the surface and never fetched", async () => {
	const { claim, answered, reads } = roomsSetup();
	const admission = claim.admit(
		roomMessage("app:agent.coder", {
			attachments: [
				{
					url: "app-upload:u1",
					name: "note.txt",
					size: 16,
					contentType: "text/plain",
				},
			],
		}),
	);
	if (admission?.kind !== "turn") throw new Error("expected a turn");
	await admission.run();
	expect(reads).toEqual(["app-upload:u1"]);
	expect(answered[0]?.files).toEqual(["note.txt"]);
});

test("a surface's maxAttachmentBytes lets a turn take a file past 25 MiB handed by path", async () => {
	const dir = mkdtempSync(join(tmpdir(), "agent-claim-big-"));
	try {
		const path = join(dir, "upload.bin");
		const size = 30 * 1024 * 1024;
		await Bun.write(path, new Uint8Array(size));
		const ref = {
			url: "app-upload:big",
			name: "big.bin",
			size,
			contentType: "application/octet-stream",
		};
		const readAttachment = async () => ({ path });
		const big = roomsSetup(["app"], {
			maxAttachmentBytes: 100 * 1024 * 1024,
			readAttachment,
		});
		const taken = big.claim.admit(
			roomMessage("app:agent.coder", { attachments: [ref] }),
		);
		if (taken?.kind !== "turn") throw new Error("expected a turn");
		await taken.run();
		expect(big.answered[0]?.files).toEqual(["big.bin"]);

		// Without the setting the surface keeps the 25 MiB every surface has.
		const plain = roomsSetup(["app"], { readAttachment });
		const refused = plain.claim.admit(
			roomMessage("app:agent.coder", { attachments: [ref] }),
		);
		if (refused?.kind !== "turn") throw new Error("expected a turn");
		await refused.run();
		expect(plain.answered[0]?.files).toEqual([]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
