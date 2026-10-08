import { attachmentsOf } from "../attachments/turn-attachments.ts";
import type {
	Admission,
	BackgroundTarget,
	ChannelClaim,
	InboundMessage,
} from "../contract/channels.ts";
import type { AgentRuntime } from "../contract/runtime.ts";
import type { SurfacePort } from "../contract/surface.ts";
import type { ChannelKey } from "../domain/conversation.ts";
import { messages } from "../i18n/index.ts";
import type { OwnerIdentity } from "../identity.ts";
import type { Logger } from "../log.ts";
import { withReference } from "../routing/message-text.ts";
import { outcome } from "../routing/settle-turn.ts";
import { systemTurn } from "../routing/system-turns.ts";
import { addressee, attributed } from "../speakers.ts";
import type { DiscordAgentTeam } from "./agent-team.ts";
import { discordIdOf } from "./team-keys.ts";

/**
 * The agent server outranks every other claim on the Discord channels it owns, and its guild's
 * other channels stay silent even when another plugin's mode or a mention would answer there; a claim of a
 * plugin must use a higher priority to answer in that guild. It owns no channel of another
 * surface. It becomes the core's reserved branch once the team moves into the core
 * (pi-roundtable batch 7).
 */
export const AGENT_SERVER_PRIORITY = 100;

/**
 * The host's own background target: the conversations of the owner and of the agent server. The
 * agent server contributes it, so schedules and delegated tasks made in those conversations carry
 * its name and limits. Its label is read when a list is shown, never when this module loads,
 * because the host applies its catalog at startup.
 */
export const OWNER_TARGET: BackgroundTarget = {
	name: "owner",
	label: () => messages().scheduleModeOwner,
	schedules: { perChannel: 20, promptChars: 8_000, aheadDays: 366 },
	delegation: { maxRunning: 3 },
};

export interface AgentClaimOptions {
	/** The owner, as forwarded messages name them. */
	owner: OwnerIdentity;
	team: Pick<
		DiscordAgentTeam,
		| "guildId"
		| "owns"
		| "answerOwner"
		| "answerGroup"
		| "answerBackground"
		| "startFresh"
	>;
	runtime: Pick<AgentRuntime, "steer" | "stop">;
	surface: Pick<SurfacePort, "react" | "unreact">;
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
	const { team, runtime, surface, attachmentDir, logger, fetchImpl } = options;
	const attachments = (message: InboundMessage) =>
		attachmentsOf(message, attachmentDir(message.channel), logger, fetchImpl);

	const webhookReport = (message: InboundMessage): Admission | undefined => {
		const text = message.text.trim();
		if (!text) return undefined;
		return {
			kind: "background",
			// The host's own turn, at the owner tier as in 0.8; what the webhook posted is untrusted input.
			turn: systemTurn({
				channel: message.channel,
				target: OWNER_TARGET.name,
				author: { id: message.authorId, name: message.authorName },
				tier: "owner",
				turnId: `webhook-${message.messageId}`,
				text: `Webhook "${message.authorName}" posted in your channel:\n${text}`,
				report: true,
			}),
			unanswered: (result) =>
				logger.warn(
					{
						channel: message.channel,
						webhook: message.integration?.id,
						outcome: result,
					},
					"webhook post not answered",
				),
		};
	};

	return {
		name: "agent-server",
		priority: AGENT_SERVER_PRIORITY,
		// Only Discord keys: another surface's channel is never the agent server's, whatever its id.
		owns: (channel, space) =>
			discordIdOf(channel) !== undefined &&
			(team.owns(channel) !== undefined ||
				(space !== undefined && space === team.guildId)),
		admit: (message) => {
			const owned = team.owns(message.channel);
			// The agent server's other channels are the owner's notes: nothing there is answered.
			if (!owned) return undefined;
			if (owned === "agent" && message.integration && !message.integration.own)
				return webhookReport(message);
			// Who may talk to the agents, and at which tier, the router resolved through the identity service.
			const { speaker } = message;
			if (message.authorIsBot || !speaker) return undefined;
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
			// Fail closed: a turn for any target but the owner's never reaches the owner's tools.
			if (turn.target !== OWNER_TARGET.name)
				return {
					status: "skipped",
					reason: `the agent server answers only "${OWNER_TARGET.name}" background turns`,
				};
			const owned = team.owns(turn.channel);
			if (owned === "group")
				return { status: "skipped", reason: "groups have no schedules" };
			// Who the turn runs as, checked by the router: its author's principal, at a tier they hold.
			const { speaker } = turn;
			if (!speaker)
				return {
					status: "skipped",
					reason:
						"a background turn reaches the agent server through the router, which says whom it runs as",
				};
			return outcome(
				await team.answerBackground(
					turn.channel,
					speaker,
					turn.text,
					turn.report === true,
				),
			);
		},
		stop: (channel) => runtime.stop(channel),
		startFresh: async (channel) => {
			await team.startFresh(channel);
			return "agent";
		},
	};
}
