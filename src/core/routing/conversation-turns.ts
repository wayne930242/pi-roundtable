import type { AgentRuntime } from "../contract/runtime.ts";
import type { SurfacePort } from "../contract/surface.ts";
import type {
	ConversationRegistry,
	ConversationVisibility,
} from "../conversations/conversation-registry.ts";
import type { TurnAttachments } from "../domain/attachment.ts";
import type { TurnResult } from "../domain/conversation.ts";
import type { TurnConversation } from "../domain/ports.ts";
import type { TurnProgress } from "../domain/progress.ts";
import { HostStoppingError, PluginError } from "../errors.ts";
import { messages } from "../i18n/index.ts";
import { SYSTEM_PRINCIPAL } from "../identity/principal-store.ts";
import type { Logger } from "../log.ts";
import type { EventSink } from "../plugin.ts";
import { splitReply } from "../presentation/reply-splitter.ts";
import { thinkingLine } from "../presentation/thinking-line.ts";
import { withReplyFiles } from "../reply-files.ts";
import type { ChannelKey, ToolSelection, TurnSelection } from "../sessions.ts";
import type { Speaker } from "../speakers.ts";
import { endOf, settleTurn } from "./settle-turn.ts";

/** One turn of a conversation, as a claim asks for it. */
export interface ConversationTurnInput {
	/** The conversation's channel; its surface shows typing and the stop control, and posts the reply. */
	channel: ChannelKey;
	/** The conversation's kind: picks the persona of its session, fixed when the session is made. */
	kind: string;
	text: string;
	/** Who the turn is for; its tier limits the tools. */
	speaker: Speaker;
	/** Files and images the message carries. */
	attachments?: TurnAttachments;
	/** The turn's tools; by default the plugins' `agentSelection`, read at the turn. */
	selection?: TurnSelection;
	/** The owner's own chat turn, which their next messages may steer. */
	steerable?: boolean;
	/** The turn may ask the owner on the surface's prompts, such as approvals of held actions. */
	interactive?: boolean;
	/** The owner confirmed the channel's held actions, so they may run in this turn. */
	confirmed?: boolean;
	/**
	 * Posts the turn's outcome in place of the default reply (the text, or a failure or stopped
	 * notice); the claim formats its own. A throw is logged, never rethrown.
	 */
	reply?(result: TurnResult): Promise<void>;
	/**
	 * How the conversation is recorded at its first turn: `private` to the speaker, or `shared`
	 * (the default). Later turns keep what the first recorded, and give a title only then.
	 */
	conversation?: { visibility: ConversationVisibility; title?: string };
}

/**
 * Runs the turns of conversations a claim owns, through the runtime and the surfaces, so a claim
 * writes no turn pipeline of its own.
 */
export interface ConversationTurns {
	/**
	 * Runs one turn in a conversation the caller's claim owns; call it inside the claim's queue
	 * task. It shows typing and the stop control on the channel's surface, emits `turnStarted` and
	 * `turnEnded` with the turn's `kind`, settles a runtime that throws into a failed result, and
	 * posts the reply, or a failure or stopped notice, through the surface unless `reply` is given.
	 * It rejects during setup (NotLinkedError), once the host is shutting down (HostStoppingError),
	 * when the host has no runtime to run the turn on,
	 * when the conversation cannot be recorded in the host's registry (a database error, or a
	 * `private` conversation without a speaker), and when the conversation is recorded private to a
	 * principal other than the speaker's, unless the speaker is the host's own (`SYSTEM_PRINCIPAL`).
	 * Each of these rejects before the turn starts:
	 * nothing is shown, no event is emitted, and `reply` is not called, so a claim that answers
	 * its person tells them itself.
	 */
	run(input: ConversationTurnInput): Promise<TurnResult>;
}

export interface ConversationTurnsOptions {
	/** Throws NotLinkedError until every plugin is set up and linked. */
	linked: () => void;
	/** Whether the host is shutting down, so no turn starts; undefined or false while it serves. */
	stopping?: () => boolean;
	/** The runtime that runs the turn; throws PluginError when the host has none yet. */
	runtime: () => AgentRuntime;
	/** Where each turn records its conversation; absent, or undefined, records none. */
	registry?: () => Pick<ConversationRegistry, "register"> | undefined;
	surfaces: SurfacePort;
	events: EventSink;
	/** The plugins' agent selection, read at each turn that gives none of its own. */
	selection: () => ToolSelection;
	logger: Logger;
}

/** The selection of a turn that gives none: the plugins' `agentSelection`. */
const DEFAULT_SELECTION = "turns";

/**
 * Records the conversation of a turn, private to the speaker when asked, else shared, and returns
 * who it belongs to as the record keeps it; without a registry, as the turn asks, if it does.
 */
async function record(
	registry: Pick<ConversationRegistry, "register"> | undefined,
	input: ConversationTurnInput,
): Promise<TurnConversation | undefined> {
	const visibility = input.conversation?.visibility ?? "shared";
	if (visibility === "private" && !input.speaker)
		throw new PluginError(
			`a private conversation needs the speaker it belongs to; ${input.channel} was run without one.`,
		);
	if (!registry)
		return input.conversation && conversationOf(visibility, input.speaker);
	const title = input.conversation?.title;
	const kept = await registry.register({
		key: input.channel,
		kind: input.kind,
		visibility,
		...(visibility === "private"
			? { principalId: input.speaker.principalId }
			: {}),
		...(title === undefined ? {} : { title }),
	});
	if (kept.visibility !== "private" || kept.principalId === undefined)
		return { visibility: "shared" };
	// Only its person, or the host itself, speaks in a private conversation: anyone else's turn would
	// read and act on what is theirs.
	const { principalId } = input.speaker;
	if (principalId !== kept.principalId && principalId !== SYSTEM_PRINCIPAL)
		throw new PluginError(
			`${input.channel} is private to ${kept.principalId}, so ${principalId} may not speak in it; run their turn in a conversation of their own.`,
		);
	return { visibility: "private", principalId: kept.principalId };
}

function conversationOf(
	visibility: ConversationVisibility,
	speaker: Speaker,
): TurnConversation {
	return visibility === "private"
		? { visibility, principalId: speaker.principalId }
		: { visibility };
}

export function conversationTurns(
	options: ConversationTurnsOptions,
): ConversationTurns {
	const { surfaces, events, logger } = options;
	return {
		async run(input) {
			const { channel, kind, speaker } = input;
			options.linked();
			// Refused before anything is shown or recorded, like a turn the host cannot run.
			if (options.stopping?.()) throw new HostStoppingError();
			// A host without a runtime is a setup mistake, so it is refused before anything is shown.
			const runtime = options.runtime();
			// A conversation that cannot be recorded runs no turn: who it belongs to would be lost.
			const conversation = await record(options.registry?.(), input);
			const stopTyping = surfaces.startTyping(channel);
			const hideStop = surfaces.showStop(channel);
			const turn = { kind, channel, speaker };
			events.turnStarted(turn);
			// A claim that posts its own reply formats its own text, so only the default reply posts as it goes.
			const interim = input.reply ? undefined : surfaces.interim(channel);
			// What the runtime reports as it goes reaches the surface and the handlers until the turn ends.
			let live = true;
			const progress = (event: TurnProgress) => {
				if (!live) return;
				events.turnProgress?.({ ...turn, progress: event });
				// pi-lens-ignore: no-unknown-parameters — a rejection reason is unknown; it only reaches the logger
				surfaces
					.progress?.(channel, event)
					?.catch((error: unknown) =>
						logger.warn({ channel, kind, err: error }, "progress not shown"),
					);
			};
			let result: TurnResult;
			try {
				result = await settleTurn(
					() =>
						withReplyFiles(surfaces.of(channel)?.supportsFiles === true, () =>
							runtime.runTurn({
								channel,
								kind,
								selection: input.selection ?? {
									id: DEFAULT_SELECTION,
									...options.selection(),
								},
								text: input.text,
								speaker,
								...(conversation ? { conversation } : {}),
								...(input.attachments
									? { attachments: input.attachments }
									: {}),
								...(input.confirmed ? { confirmed: true } : {}),
								...(input.steerable ? { steerable: true } : {}),
								...(input.interactive ? { interactive: true } : {}),
								...(interim ? { interim } : {}),
								progress,
							}),
						),
					"conversation turn",
				);
			} finally {
				live = false;
				hideStop();
			}
			events.turnEnded({
				...turn,
				result: endOf(result),
			});
			try {
				if (!result.ok && !result.stopped)
					logger.error({ channel, kind, err: result.error }, "turn failed");
				if (input.reply) await input.reply(result);
				else await surfaces.sendReply(channel, replyOf(result));
			} catch (error) {
				logger.error({ channel, kind, err: error }, "reply not posted");
			} finally {
				stopTyping();
			}
			return result;
		},
	};
}

/** The default post: the answer with its thinking line, or the failure or stopped notice. */
function replyOf(result: TurnResult) {
	if (!result.ok)
		return {
			chunks: [
				result.stopped ? messages().stoppedNotice : messages().failureNotice,
			],
		};
	const thinking = result.thinking ? thinkingLine(result.thinking) : undefined;
	return {
		...(thinking ? { thinking } : {}),
		chunks: splitReply(result.text),
		...(result.files?.length ? { files: result.files } : {}),
	};
}
