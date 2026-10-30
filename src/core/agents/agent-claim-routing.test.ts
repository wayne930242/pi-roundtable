import { expect, test } from "bun:test";
import type { InboundMessage } from "../contract/channels.ts";
import { SYSTEM_PRINCIPAL } from "../identity/principal-store.ts";
import { silentLogger } from "../log.ts";
import { PERSONAL_TARGET } from "../modules/background/personal-target.ts";
import { ChannelQueue } from "../routing/channel-queue.ts";
import { ChannelRouter } from "../routing/channel-router.ts";
import { TEST_OWNER } from "../testing/owner.ts";
import { agentClaim } from "./agent-claim.ts";

const webhook = (
	channel: `${string}:${string}`,
	extra: Partial<InboundMessage> = {},
): InboundMessage => ({
	channel,
	messageId: "m1",
	authorId: "hook-user",
	authorName: "Alertmanager",
	authorIsBot: true,
	isDirect: false,
	space: "1",
	mentionsBot: false,
	repliesToBot: false,
	text: "disk 91% on db-1",
	attachments: [],
	integration: { id: "hook", own: false },
	...extra,
});

function claimOf(
	integrationChannel?: (origin: string) => string,
	ran: { channel: string; report: boolean }[] = [],
) {
	return agentClaim({
		owner: TEST_OWNER,
		team: {
			guildId: "1",
			owns: (channel: string) =>
				channel === "discord:2000" || channel === "app:agent.infra"
					? ("agent" as const)
					: undefined,
			answerOwner: async () => ({ ok: true as const, text: "" }),
			answerGroup: async () => undefined,
			answerBackground: async (
				channel: string,
				_speaker: unknown,
				_text: string,
				report: boolean,
			) => {
				ran.push({ channel, report });
				return { ok: true as const, text: "" };
			},
			startFresh: async () => undefined,
		} as never,
		runtime: { steer: async () => false, stop: () => true },
		surface: {
			react: async () => undefined,
			unreact: async () => undefined,
			roomSurfaces: () => ["app"],
		},
		attachmentDir: () => "/tmp",
		logger: silentLogger(),
		...(integrationChannel
			? { integrationChannel: integrationChannel as never }
			: {}),
	});
}

test("without a rule, a webhook's report runs in the channel it was posted in, as before", () => {
	const admission = claimOf().admit(webhook("discord:2000"));
	expect(admission).toMatchObject({
		kind: "background",
		turn: {
			channel: "discord:2000",
			target: "owner",
			report: true,
			tier: "owner",
			text: 'Webhook "Alertmanager" posted in your channel:\ndisk 91% on db-1',
			author: { principalId: SYSTEM_PRINCIPAL },
		},
	});
});

test("a rule that keeps the report in its origin changes nothing", () => {
	const admission = claimOf((origin) => origin).admit(webhook("discord:2000"));
	expect(admission).toMatchObject({
		kind: "background",
		turn: {
			channel: "discord:2000",
			text: 'Webhook "Alertmanager" posted in your channel:\ndisk 91% on db-1',
		},
	});
});

test("a rule that moves the report runs it in the other place and tells the agent where the raw post is", () => {
	const admission = claimOf(() => "app:agent.infra").admit(
		webhook("discord:2000"),
	);
	expect(admission).toMatchObject({
		kind: "background",
		turn: {
			channel: "app:agent.infra",
			target: "owner",
			report: true,
			text: 'Webhook "Alertmanager" posted in your discord place (discord:2000):\ndisk 91% on db-1',
		},
	});
});

test("a post nobody owns, or with no text, is still ignored under a rule", () => {
	const claim = claimOf(() => "app:agent.infra");
	expect(claim.admit(webhook("discord:9999"))).toBeUndefined();
	expect(claim.admit(webhook("discord:2000", { text: "  " }))).toBeUndefined();
});

test("through the router, the moved report turn runs in the other place, as a report", async () => {
	const ran: { channel: string; report: boolean }[] = [];
	const router = new ChannelRouter({
		claims: [claimOf(() => "app:agent.infra", ran)],
		targets: (name) =>
			name === PERSONAL_TARGET.name ? PERSONAL_TARGET : undefined,
		queue: new ChannelQueue(),
		logger: silentLogger(),
	});
	await router.handle(webhook("discord:2000"));
	expect(ran).toEqual([{ channel: "app:agent.infra", report: true }]);
});
