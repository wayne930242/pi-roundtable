import { expect, test } from "bun:test";
import type { InboundMessage } from "../contract/channels.ts";
import { silentLogger } from "../log.ts";
import { type Speaker, speakerPolicy } from "../speakers.ts";
import { TEST_OWNER } from "../testing/owner.ts";
import { agentClaim } from "./agent-claim.ts";

const OWNER = "100000000000000001";
const ADMIN = "100000000000000002";
const STRANGER = "100000000000000009";
const ROLE = "200000000000000001";

function setup() {
	const answered: { kind: string; speaker: Speaker; text: string }[] = [];
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
		runtime: { steer: async () => false },
		surface: { react: async () => {}, unreact: async () => {} },
		attachmentDir: () => "/tmp",
		logger: silentLogger(),
	});
	return { claim, answered };
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
	guildId: "1",
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
		mode: "owner" as const,
		author: { id: ADMIN, name: "n" },
		turnId: "t",
		text: "go",
	};
	await claim.background?.({ ...turn, tier: "admin" });
	await claim.background?.(turn);
	expect(answered.map((a) => a.speaker.tier)).toEqual(["admin", "owner"]);
});
