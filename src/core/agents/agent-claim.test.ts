import { afterAll, expect, test } from "bun:test";
import type { ChannelClaim, InboundMessage } from "../contract/channels.ts";
import { setLocale } from "../i18n/index.ts";
import { silentLogger } from "../log.ts";
import { ChannelQueue } from "../routing/channel-queue.ts";
import { ChannelRouter } from "../routing/channel-router.ts";
import { type Speaker, speakerPolicy } from "../speakers.ts";
import { useTestLocale } from "../testing/locale.ts";
import { TEST_OWNER } from "../testing/owner.ts";
import { agentClaim, OWNER_TARGET } from "./agent-claim.ts";

const OWNER = "100000000000000001";
const ADMIN = "100000000000000002";
const STRANGER = "100000000000000009";
const ROLE = "200000000000000001";

function setup() {
	const answered: { kind: string; speaker: Speaker; text: string }[] = [];
	const stopped: string[] = [];
	const team = {
		guildId: "1",
		owns: (channel: string) =>
			channel === "discord:10"
				? ("agent" as const)
				: channel === "discord:20"
					? ("group" as const)
					: undefined,
		answerOwner: async (_c: string, speaker: Speaker, text: string) => {
			answered.push({ kind: "agent", speaker, text });
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
	const claim = agentClaim({
		owner: TEST_OWNER,
		speakers: speakerPolicy({
			owners: [OWNER],
			admins: { users: [ADMIN] },
			members: { roles: [ROLE] },
		}),
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
	});
	return { claim, answered, stopped };
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

test("a background turn runs at its creator's tier, the owner's when a person set none", async () => {
	const { claim, answered } = setup();
	const turn = {
		channel: "discord:10" as const,
		target: "owner",
		author: { id: ADMIN, name: "n" },
		turnId: "t",
		text: "go",
	};
	await claim.background?.({ ...turn, tier: "admin" });
	await claim.background?.(turn);
	expect(answered.map((a) => a.speaker.tier)).toEqual(["admin", "owner"]);
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
		author: { id: ADMIN, name: "n" },
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

test("a webhook post in an agent's channel is a report turn for the owner target", () => {
	const { claim } = setup();
	const admission = claim.admit({
		...message("webhook", "discord:10"),
		integration: { id: "hook", own: false },
		text: "build failed",
	});
	expect(admission).toMatchObject({
		kind: "background",
		turn: { target: "owner", report: true },
	});
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
