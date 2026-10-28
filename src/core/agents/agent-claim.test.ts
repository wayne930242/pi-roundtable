import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChannelClaim, InboundMessage } from "../contract/channels.ts";
import type { ChatSurface } from "../contract/surface.ts";
import type { AttachmentFailure } from "../domain/attachment.ts";
import { setLocale } from "../i18n/index.ts";
import { SYSTEM_PRINCIPAL } from "../identity/principal-store.ts";
import { silentLogger } from "../log.ts";
import { ChannelQueue } from "../routing/channel-queue.ts";
import { ChannelRouter } from "../routing/channel-router.ts";
import { isSystemTurn } from "../routing/system-turns.ts";
import { type Speaker, speakerPolicy } from "../speakers.ts";
import { useTestLocale } from "../testing/locale.ts";
import { TEST_OWNER } from "../testing/owner.ts";
import { agentClaim, OWNER_TARGET } from "./agent-claim.ts";

const OWNER = "100000000000000001";
const ADMIN = "100000000000000002";
const STRANGER = "100000000000000009";
const ROLE = "200000000000000001";

function setup(
	channelContext?: Parameters<typeof agentClaim>[0]["channelContext"],
	speakers?: "everyone" | "owners",
	extra: Partial<Parameters<typeof agentClaim>[0]> = {},
) {
	const answered: {
		kind: string;
		speaker: Speaker;
		text: string;
		images?: readonly unknown[];
		failures?: readonly AttachmentFailure[];
	}[] = [];
	const stopped: string[] = [];
	const team = {
		guildId: "1",
		owns: (channel: string) =>
			channel === "discord:10"
				? ("agent" as const)
				: channel === "discord:20"
					? ("group" as const)
					: undefined,
		answerOwner: async (
			_c: string,
			speaker: Speaker,
			text: string,
			_reply: string,
			carried: {
				images: readonly unknown[];
				failures?: readonly AttachmentFailure[];
			},
		) => {
			answered.push({
				kind: "agent",
				speaker,
				text,
				images: carried.images,
				...(carried.failures ? { failures: carried.failures } : {}),
			});
			return { ok: true as const, text: "" };
		},
		answerGroup: async (_c: string, speaker: Speaker, text: string) => {
			answered.push({ kind: "group", speaker, text });
		},
		answerBackground: async (_c: string, speaker: Speaker, text: string) => {
			answered.push({ kind: "background", speaker, text });
			return { ok: true as const, text: "" };
		},
		startFresh: async () => {},
	};
	const policy = speakerPolicy({
		owners: [OWNER],
		admins: { users: [ADMIN] },
		members: { roles: [ROLE] },
	});
	const bare = agentClaim({
		owner: TEST_OWNER,
		...(speakers ? { speakers } : {}),
		// biome-ignore lint/suspicious/noExplicitAny: a recording stand-in for the team
		team: team as any,
		runtime: {
			steer: async () => false,
			stop: (channel: string) => {
				stopped.push(channel);
				return true;
			},
		},
		surface: { react: async () => {}, unreact: async () => {} },
		attachmentDir: () => "/tmp",
		logger: silentLogger(),
		...(channelContext ? { channelContext } : {}),
		...extra,
	});
	// The router resolves who wrote a message before a claim admits it; the 0.8 map stands in for the identity service.
	const claim: ChannelClaim = {
		...bare,
		admit: (m) => {
			const speaker =
				m.authorIsBot || m.integration
					? undefined
					: policy.resolve({
							id: m.authorId,
							name: m.authorName,
							roleIds: m.authorRoleIds ?? [],
						});
			return bare.admit(speaker ? { ...m, speaker } : m);
		},
	};
	return { claim, bare, answered, stopped };
}

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

test("the owner, an admin, and a member by role are each answered as themselves", async () => {
	const { claim, answered } = setup();
	for (const [id, roles] of [
		[OWNER, []],
		[ADMIN, []],
		[STRANGER, [ROLE]],
	] as const) {
		const admission = claim.admit(
			message(id, "discord:10", { authorRoleIds: roles }),
		);
		if (admission?.kind !== "turn") throw new Error("expected a turn");
		await admission.run();
	}
	expect(answered.map((a) => a.speaker.tier)).toEqual([
		"owner",
		"admin",
		"member",
	]);
	expect(answered[1]?.speaker).toEqual({
		id: ADMIN,
		name: "name-2",
		tier: "admin",
		principalId: ADMIN,
	});
});

test("a turn in an agent's channel names a speaker who is not the owner, and the owner's stays plain", async () => {
	const { claim, answered } = setup();
	for (const id of [OWNER, ADMIN]) {
		const admission = claim.admit(message(id, "discord:10"));
		if (admission?.kind !== "turn") throw new Error("expected a turn");
		await admission.run();
	}
	expect(answered[0]?.text).toBe("hello");
	expect(answered[1]?.text).toBe(
		"(Message from name-2, at the admin tier.)\n\nhello",
	);
});

const AROUND = {
	messages: [
		{
			id: "c1",
			authorId: "300",
			authorName: "Kai",
			bot: false,
			owner: false,
			text: "the build is red",
			at: new Date(0),
		},
	],
	text: "## Channel messages since your last answer\n<channel-context>…</channel-context>",
};

test("a turn in an agent's channel carries the channel context after its text, for the message it answers", async () => {
	const asked: InboundMessage[] = [];
	const { claim, answered } = setup(async (m) => {
		asked.push(m);
		return AROUND;
	});
	for (const id of [OWNER, ADMIN]) {
		const admission = claim.admit(message(id, "discord:10"));
		if (admission?.kind !== "turn") throw new Error("expected a turn");
		await admission.run();
	}
	expect(asked.map((m) => m.authorId)).toEqual([OWNER, ADMIN]);
	expect(answered.map((a) => a.text)).toEqual([
		`hello\n\n${AROUND.text}`,
		`(Message from name-2, at the admin tier.)\n\nhello\n\n${AROUND.text}`,
	]);
});

test("a group's turn reads no channel context: its round already carries what was said since its last turn", async () => {
	let asked = 0;
	const { claim, answered } = setup(async () => {
		asked++;
		return AROUND;
	});
	const admission = claim.admit(message(OWNER, "discord:20"));
	if (admission?.kind !== "turn") throw new Error("expected a turn");
	await admission.run();
	expect(asked).toBe(0);
	expect(answered[0]?.text).toBe("hello");
});

test("channel context that throws is logged and the turn runs on its own text", async () => {
	const { claim, answered } = setup(async () => {
		throw new Error("boom");
	});
	const admission = claim.admit(message(OWNER, "discord:10"));
	if (admission?.kind !== "turn") throw new Error("expected a turn");
	await admission.run();
	expect(answered[0]?.text).toBe("hello");
});

test("an author the policy does not name gets no turn, in an agent or a group channel", () => {
	const { claim } = setup();
	expect(claim.admit(message(STRANGER, "discord:10"))).toBeUndefined();
	expect(claim.admit(message(STRANGER, "discord:20"))).toBeUndefined();
	expect(
		claim.admit(message(OWNER, "discord:10", { authorIsBot: true })),
	).toBeUndefined();
});

test("a group message carries its speaker", async () => {
	const { claim, answered } = setup();
	const admission = claim.admit(message(ADMIN, "discord:20"));
	if (admission?.kind !== "turn") throw new Error("expected a turn");
	await admission.run();
	expect(answered[0]).toMatchObject({
		kind: "group",
		speaker: { tier: "admin" },
	});
});

test("a background turn runs as the speaker the router checked, the principal who set it up, never as the author's surface id", async () => {
	const { claim, answered } = setup();
	// A member admitted at first contact: their principal is not their Discord id.
	const speaker: Speaker = {
		id: ADMIN,
		name: "n",
		tier: "admin",
		principalId: "p_01JADMIN",
	};
	const turn = {
		channel: "discord:10" as const,
		target: "owner",
		author: { principalId: "p_01JADMIN", id: ADMIN, name: "n" },
		tier: "owner" as const,
		turnId: "t",
		text: "go",
	};
	await claim.background?.({ ...turn, speaker });
	expect(answered.map((a) => a.speaker)).toEqual([speaker]);
	// Handed one without the router's speaker, it runs nothing, rather than as anyone at any tier.
	expect(await claim.background?.(turn)).toMatchObject({ status: "skipped" });
	expect(answered).toHaveLength(1);
});

afterAll(useTestLocale);

test("the owner target's label is read when a list asks for it, in the catalog then active", () => {
	setLocale("en", { assistant: "Zed", root: "zed" });
	expect(OWNER_TARGET.label("en")).toBe("Zed");
	setLocale("zh-TW", { assistant: "Yen", root: "yen" });
	expect(OWNER_TARGET.label("zh-TW")).toBe("Yen");
});

test("the agent server answers only the owner target, and skips any other", async () => {
	const { claim, answered } = setup();
	const turn = {
		channel: "discord:10" as const,
		author: { principalId: ADMIN, id: ADMIN, name: "n" },
		tier: "admin" as const,
		speaker: {
			id: ADMIN,
			name: "n",
			tier: "admin" as const,
			principalId: ADMIN,
		},
		turnId: "t",
		text: "go",
	};
	for (const target of ["support", "", "Owner"])
		expect(await claim.background?.({ ...turn, target })).toEqual({
			status: "skipped",
			reason: 'the agent server answers only "owner" background turns',
		});
	expect(answered).toEqual([]);
});

test("only the speaker the router resolved is answered: a message from the owner's id without one is no one's", () => {
	const { bare, answered } = setup();
	expect(bare.admit(message(OWNER, "discord:10"))).toBeUndefined();
	const admission = bare.admit(
		message(STRANGER, "discord:10", {
			speaker: {
				id: STRANGER,
				name: "Sam",
				tier: "owner",
				principalId: "p_owner2",
			},
		}),
	);
	expect(admission?.kind).toBe("turn");
	expect(answered).toEqual([]);
});

test("a webhook post in an agent's channel is a report turn for the owner target", () => {
	const { claim } = setup();
	const admission = claim.admit({
		...message("webhook", "discord:10"),
		integration: { id: "hook", own: false },
		text: "build failed",
	});
	expect(admission).toMatchObject({
		kind: "background",
		turn: {
			target: "owner",
			report: true,
			author: { principalId: SYSTEM_PRINCIPAL, id: "webhook" },
			tier: "owner",
		},
	});
	// The host's own turn, which the router runs as the system principal; a copy of it would not run.
	expect(admission?.kind === "background" && isSystemTurn(admission.turn)).toBe(
		true,
	);
});

test("with owners-only speakers, an admin's and a member's message starts no turn in an agent's or group's channel, and the owner's does", async () => {
	const { claim, answered } = setup(undefined, "owners");
	for (const channel of ["discord:10", "discord:20"] as const) {
		expect(claim.admit(message(ADMIN, channel))).toBeUndefined();
		expect(
			claim.admit(message(STRANGER, channel, { authorRoleIds: [ROLE] })),
		).toBeUndefined();
		const admission = claim.admit(message(OWNER, channel));
		if (admission?.kind !== "turn") throw new Error("expected a turn");
		await admission.run();
	}
	expect(answered.map((a) => [a.kind, a.speaker.tier])).toEqual([
		["agent", "owner"],
		["group", "owner"],
	]);
});

test("with owners-only speakers, an outside webhook's report in an agent's channel is unchanged", () => {
	const { claim } = setup(undefined, "owners");
	expect(
		claim.admit({
			...message("webhook", "discord:10"),
			integration: { id: "hook", own: false },
			text: "build failed",
		}),
	).toMatchObject({ kind: "background", turn: { report: true } });
});

test("by default, and with speakers everyone, admins and members are answered as before", () => {
	for (const speakers of [undefined, "everyone"] as const) {
		const { claim } = setup(undefined, speakers);
		expect(claim.admit(message(ADMIN, "discord:10"))?.kind).toBe("turn");
		expect(
			claim.admit(message(STRANGER, "discord:20", { authorRoleIds: [ROLE] }))
				?.kind,
		).toBe("turn");
	}
});

test("the agent server owns only Discord channels: a key of another surface is never taken, even with its id or guild", () => {
	const { claim } = setup();
	// A host's own `mcp:` conversations, and a surface a plugin contributes.
	for (const key of ["mcp:10", "fake:10", "fake:20"] as const) {
		expect(claim.owns(key)).toBe(false);
		expect(claim.owns(key, "1")).toBe(false);
	}
});

test("the agent server still owns its agents' channels, and stays silent in the rest of its guild", () => {
	const { claim } = setup();
	expect(claim.owns("discord:10")).toBe(true);
	expect(claim.owns("discord:20")).toBe(true);
	expect(claim.owns("discord:99", "1")).toBe(true);
	expect(claim.admit(message(OWNER, "discord:99"))).toBeUndefined();
	// Another guild's channels are not its own.
	expect(claim.owns("discord:99", "2")).toBe(false);
	expect(claim.owns("discord:99")).toBe(false);
});

test("a stop goes to the runtime for the channel it was asked in", () => {
	const { claim, stopped } = setup();
	expect(claim.stop?.("discord:10")).toBe(true);
	expect(stopped).toEqual(["discord:10"]);
});

test("a claim of a plugin at priority 10 on another surface's keys hears its messages while the agent server runs, and the agent server's own channels stay its", async () => {
	const { claim: agents, answered } = setup();
	const heard: string[] = [];
	const stranger: ChannelClaim = {
		name: "fake-channels",
		priority: 10,
		owns: (channel) => channel.startsWith("fake:"),
		admit: (m) => ({
			kind: "turn",
			run: async () => void heard.push(`${m.channel} ${m.text}`),
			failure: "fake failed",
		}),
		startFresh: async () => "fake",
	};
	const mcp: ChannelClaim = {
		...stranger,
		name: "mcp",
		priority: 0,
		owns: (channel) => channel.startsWith("mcp:"),
	};
	const router = new ChannelRouter({
		claims: [agents, stranger, mcp],
		targets: () => undefined,
		queue: new ChannelQueue(),
		logger: silentLogger(),
	});
	// The ids are an agent's channel and the agent guild's id, on keys of other surfaces.
	await router.handle(message(OWNER, "fake:10", { text: "a" }));
	await router.handle(message(OWNER, "fake:20", { text: "b" }));
	await router.handle(message(OWNER, "mcp:10", { text: "c" }));
	await router.handle(message(OWNER, "discord:10", { text: "d" }));
	// The rest of the agent guild stays silent, and nothing below the agent server hears it.
	await router.handle(message(OWNER, "discord:99", { text: "e" }));
	expect(heard).toEqual(["fake:10 a", "fake:20 b", "mcp:10 c"]);
	expect(answered.map((a) => a.kind)).toEqual(["agent"]);
});

const backgroundTurn = (speaker?: Speaker) => ({
	channel: "discord:10" as const,
	target: "owner",
	author: { principalId: "p_01JADMIN", id: ADMIN, name: "n" },
	tier: "owner" as const,
	turnId: "t",
	text: "go",
	...(speaker ? { speaker } : {}),
});

test("with owners-only speakers, an admin's scheduled or report turn is skipped, and the owner's and the system's still run", async () => {
	const { claim, answered } = setup(undefined, "owners");
	const admin: Speaker = {
		id: ADMIN,
		name: "n",
		tier: "admin",
		principalId: "p_01JADMIN",
	};
	const owner: Speaker = {
		id: OWNER,
		name: "o",
		tier: "owner",
		principalId: "p_01JOWNER",
	};
	for (const report of [false, true])
		expect(
			await claim.background?.({ ...backgroundTurn(admin), report }),
		).toMatchObject({ status: "skipped" });
	expect(answered).toHaveLength(0);
	await claim.background?.(backgroundTurn(owner));
	await claim.background?.({ ...backgroundTurn(owner), report: true });
	expect(answered.map((a) => a.speaker.tier)).toEqual(["owner", "owner"]);
});

test("by default, and with speakers everyone, an admin's background turn runs as before", async () => {
	for (const speakers of [undefined, "everyone"] as const) {
		const { claim, answered } = setup(undefined, speakers);
		await claim.background?.(
			backgroundTurn({
				id: ADMIN,
				name: "n",
				tier: "admin",
				principalId: "p_01JADMIN",
			}),
		);
		expect(answered.map((a) => a.speaker.tier)).toEqual(["admin"]);
	}
});

test("an agent's turn carries the channel context's images after its own, and the block mentions pictures only when some are carried", async () => {
	const image = { data: "x", mimeType: "image/png" };
	const context = { messages: [], text: "BLOCK", images: [image, image] };
	const { claim, answered } = setup(async () => context);
	const admission = claim.admit(message(OWNER, "discord:10"));
	if (admission?.kind !== "turn") throw new Error("expected a turn");
	await admission.run();
	expect(answered[0]?.images).toEqual([image, image]);
	expect(answered[0]?.text).toContain("BLOCK");
	expect(answered[0]?.text).toContain(
		"Pictures posted in the channel messages",
	);
	// Without images the text says nothing of pictures.
	const bare = setup(async () => ({ messages: [], text: "BLOCK" }));
	const plain = bare.claim.admit(message(OWNER, "discord:10"));
	if (plain?.kind !== "turn") throw new Error("expected a turn");
	await plain.run();
	expect(bare.answered[0]?.text).not.toContain("Pictures posted");
});

test("the download limits of discord.attachmentDownload reach an agent's turn: a file that goes quiet is given up and named in the turn", async () => {
	const quiet = Object.assign(
		async () => new Response(new ReadableStream({ start() {} })),
		{ preconnect: fetch.preconnect },
	) as unknown as typeof fetch;
	const dir = mkdtempSync(join(tmpdir(), "agent-claim-"));
	try {
		const { claim, answered } = setup(undefined, undefined, {
			attachmentDir: () => dir,
			fetchImpl: quiet,
			attachmentDownload: { deadlineMs: 30_000, idleMs: 60 },
		});
		const admission = claim.admit(
			message(OWNER, "discord:10", {
				attachments: [
					{
						url: "https://files.test/a",
						name: "a.txt",
						size: 1,
						contentType: "text/plain",
					},
				],
			}),
		);
		if (admission?.kind !== "turn") throw new Error("expected a turn");
		const started = Date.now();
		await admission.run();
		expect(Date.now() - started).toBeLessThan(5_000);
		expect(answered[0]?.failures).toEqual([
			{
				name: "a.txt",
				reason: "download failed: idle_timeout",
				fromReference: false,
			},
		]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ── Agent rooms on any surface ────────────────────────────────────────────

/** A team that knows `coder` and the group `ops` in rooms, and wrongly claims `other:agent.coder` too. */
function roomsSetup(roomSurfaces: readonly string[] = ["app"]) {
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
