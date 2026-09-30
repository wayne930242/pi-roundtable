import { attachmentsOf } from "../attachments/turn-attachments.ts";
import type {
	Admission,
	ChannelClaim,
	InboundMessage,
} from "../contract/channels.ts";
import type { ChannelKey } from "../domain/conversation.ts";
import type { AgentRuntime, ChatSurface } from "../domain/ports.ts";
import type { OwnerIdentity } from "../identity.ts";
import type { Logger } from "../log.ts";
import { withReference } from "../routing/message-text.ts";
import { outcome } from "../routing/settle-turn.ts";
import { addressee, attributed, type SpeakerPolicy } from "../speakers.ts";
import type { AgentTeam } from "./agent-team.ts";

/**
 * The agent server outranks every other claim, and its guild's other channels stay silent even
 * when party mode or a mention would answer there. It becomes the core's reserved branch once
 * the team moves into the core (pi-roundtable batch 7).
 */
export const AGENT_SERVER_PRIORITY = 100;

export interface AgentClaimOptions {
	/** The owner, as forwarded messages name them. */
	owner: OwnerIdentity;
	/** Who may talk to the agents, and at which tier. */
	speakers: SpeakerPolicy;
	team: Pick<
		AgentTeam,
		| "guildId"
		| "owns"
		| "answerOwner"
		| "answerGroup"
		| "answerBackground"
		| "startFresh"
	>;
	runtime: Pick<AgentRuntime, "steer">;
	surface: Pick<ChatSurface, "react" | "unreact">;
	/** Where a channel's attachments are saved. */
	attachmentDir: (channel: ChannelKey) => string;
	logger: Logger;
	/** Replaceable in tests. */
	fetchImpl?: typeof fetch;
}

/**
 * The agent server's channels: every owner message in an agent's or group's channel is answered
 * there, mention or not, and an outside webhook's post in an agent's channel, such as a CI
 * failure notice, is a labelled report turn for the agent.
 */
export function agentClaim(options: AgentClaimOptions): ChannelClaim {
	const { speakers, team, runtime, surface, attachmentDir, logger, fetchImpl } =
		options;
	const attachments = (message: InboundMessage) =>
		attachmentsOf(message, attachmentDir(message.channel), logger, fetchImpl);

	const webhookReport = (message: InboundMessage): Admission | undefined => {
		const text = message.text.trim();
		if (!text) return undefined;
		return {
			kind: "background",
			turn: {
				channel: message.channel,
				mode: "owner",
				author: { id: message.authorId, name: message.authorName },
				turnId: `webhook-${message.messageId}`,
				text: `Webhook "${message.authorName}" posted in your channel:\n${text}`,
				report: true,
			},
			unanswered: (result) =>
				logger.warn(
					{
						channel: message.channel,
						webhook: message.webhookId,
						outcome: result,
					},
					"webhook post not answered",
				),
		};
	};

	return {
		name: "agent-server",
		priority: AGENT_SERVER_PRIORITY,
		owns: (channel, guildId) =>
			team.owns(channel) !== undefined ||
			(guildId !== undefined && guildId === team.guildId),
		admit: (message) => {
			const owned = team.owns(message.channel);
			// The agent server's other channels are the owner's notes: nothing there is answered.
			if (!owned) return undefined;
			if (owned === "agent" && message.webhookId && !message.ownWebhook)
				return webhookReport(message);
			if (message.authorIsBot) return undefined;
			const speaker = speakers.resolve({
				id: message.authorId,
				name: message.authorName,
				...(message.authorRoleIds ? { roleIds: message.authorRoleIds } : {}),
			});
			if (!speaker) return undefined;
			const { channel, messageId } = message;
			const forwarder = addressee(speaker, options.owner);
			return {
				kind: "turn",
				busy: {
					// A group's round is not steered; its messages wait their turn.
					...(owned === "agent"
						? {
								steer: async () =>
									runtime.steer(
										channel,
										attributed(speaker, withReference(message, forwarder)),
										await attachments(message),
										speaker.id,
									),
							}
						: {}),
					react: (emoji) => surface.react(channel, messageId, emoji),
					unreact: (emoji) => surface.unreact(channel, messageId, emoji),
				},
				run: async () => {
					const saved = await attachments(message);
					const text = withReference(message, forwarder);
					// A group's history already names each author.
					if (owned === "agent")
						await team.answerOwner(
							channel,
							speaker,
							attributed(speaker, text),
							message.text,
							saved,
						);
					else
						await team.answerGroup(
							channel,
							speaker,
							text,
							message.text,
							saved,
							message.reference?.webhookName,
						);
				},
				failure: "agent message handling failed",
			};
		},
		background: async (turn) => {
			if (turn.mode === "party")
				return { status: "skipped", reason: "party mode is off" };
			const owned = team.owns(turn.channel);
			if (owned === "group")
				return { status: "skipped", reason: "groups have no schedules" };
			return outcome(
				await team.answerBackground(
					turn.channel,
					{
						id: turn.author.id,
						name: turn.author.name,
						tier: turn.tier ?? "owner",
					},
					turn.text,
					turn.report === true,
				),
			);
		},
		startFresh: async (channel) => {
			await team.startFresh(channel);
			return "agent";
		},
	};
}
