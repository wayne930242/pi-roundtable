import { expect, test } from "bun:test";
import type { InboundMessage } from "../contract/channels.ts";
import { silentLogger } from "../log.ts";
import type { Speaker } from "../speakers.ts";
import { TEST_OWNER } from "../testing/owner.ts";
import { agentClaim } from "./agent-claim.ts";

const PEER = "800000000000000001";

const peerSpeaker: Speaker = {
	id: PEER,
	name: "Peer",
	tier: "member",
	principalId: "p-peer",
};

function claimWith(answered: string[]) {
	const team = {
		guildId: "1",
		owns: (channel: string) =>
			channel === "discord:10" ? ("agent" as const) : undefined,
		answerOwner: async (_c: string, speaker: Speaker, text: string) => {
			answered.push(speaker.principalId);
			return { ok: true as const, text: "" };
		},
		answerGroup: async () => {},
		answerBackground: async () => ({ ok: true as const, text: "" }),
		startFresh: async () => {},
	};
	return agentClaim({
		owner: TEST_OWNER,
		// biome-ignore lint/suspicious/noExplicitAny: a recording stand-in for the team
		team: team as any,
		runtime: { steer: async () => false, stop: () => true },
		surface: { react: async () => {}, unreact: async () => {} },
		attachmentDir: () => "/tmp",
		logger: silentLogger(),
	});
}

const fromBot = (extra: Partial<InboundMessage>): InboundMessage => ({
	channel: "discord:10",
	messageId: "m1",
	authorId: PEER,
	authorName: "Peer",
	authorIsBot: true,
	speaker: peerSpeaker,
	isDirect: false,
	space: "1",
	mentionsBot: false,
	repliesToBot: false,
	text: "hello there",
	attachments: [],
	...extra,
});

test("a bot is answered only when the router flagged it a peer and it addresses the agent", async () => {
	const answered: string[] = [];
	const claim = claimWith(answered);
	// Not listed: no flag, whatever else it says.
	expect(claim.admit(fromBot({ mentionsBot: true }))).toBeUndefined();
	// Listed, but talking past the agent in its own channel.
	expect(claim.admit(fromBot({ peerBot: true }))).toBeUndefined();
	for (const addressing of [{ mentionsBot: true }, { repliesToBot: true }]) {
		const admission = claim.admit(fromBot({ peerBot: true, ...addressing }));
		if (admission?.kind !== "turn") throw new Error("expected a turn");
		await admission.run();
	}
	expect(answered).toEqual(["p-peer", "p-peer"]);
});

test("a listed bot the access rules do not serve gets no turn", () => {
	const claim = claimWith([]);
	const { speaker: _none, ...unserved } = fromBot({
		peerBot: true,
		mentionsBot: true,
	});
	expect(claim.admit(unserved)).toBeUndefined();
});
