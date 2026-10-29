import type {
	ChannelClaim,
	ChannelKey,
	InboundMessage,
	SurfacePort,
} from "pi-roundtable";
import { splitReply } from "pi-roundtable/kit";
import {
	type ReadChannelContext,
	readsChannelContext,
	withSandboxChannelContext,
} from "./channel-context.ts";
import type { SandboxChannelStore } from "./channel-store.ts";
import { type SandboxRuntime, SandboxTurnRefused } from "./runtime.ts";

/**
 * Rewrites a successful model reply before it is posted, such as converting script or stripping
 * markup. It runs on the host, after the sealed turn and before the reply is split into chunks;
 * failure texts never pass through it. A throw, or a value that is not a string, fails the turn.
 */
export type SandboxReplyText = (
	text: string,
	context: { channel: ChannelKey; space?: string },
) => string | Promise<string>;

export interface SandboxClaimOptions {
	/** `owns` adds channels in configured guilds; without it only `has` decides. */
	channels: Pick<SandboxChannelStore, "has"> &
		Partial<Pick<SandboxChannelStore, "owns">>;
	runtime: Pick<SandboxRuntime, "runTurn" | "stop" | "startFresh">;
	surfaces: Pick<SurfacePort, "sendReply" | "startTyping">;
	/** Told of a failed turn, with what failed (a sandbox error, or replyText's own throw). */
	reportFailure?: (channel: ChannelKey, error: unknown) => void;
	replyText?: SandboxReplyText;
	/**
	 * Reads the context of the channel a message was posted in; set to opt in. It is called only for
	 * a Discord server message, with that message, and what it returns goes before the message in
	 * the turn's text as untrusted public text.
	 */
	channelContext?: ReadChannelContext;
	/** Told when the channel context could not be read; the turn then runs without it. */
	reportContextFailure?: (channel: ChannelKey, error: unknown) => void;
}

export function isSandboxAddress(message: InboundMessage): boolean {
	return (
		!message.authorIsBot &&
		!message.integration &&
		!message.isDirect &&
		(message.mentionsBot || message.repliesToBot)
	);
}

async function contextualText(
	options: Pick<SandboxClaimOptions, "channelContext" | "reportContextFailure">,
	message: InboundMessage,
	body: string,
): Promise<string> {
	if (!options.channelContext || !readsChannelContext(message)) return body;
	try {
		return withSandboxChannelContext(
			body,
			await options.channelContext(message),
		);
	} catch (error) {
		options.reportContextFailure?.(message.channel, error);
		return body;
	}
}

async function rewriteReply(
	replyText: SandboxReplyText | undefined,
	text: string,
	message: InboundMessage,
): Promise<string> {
	if (!replyText) return text;
	const rewritten = await replyText(text, {
		channel: message.channel,
		...(message.space ? { space: message.space } : {}),
	});
	if (typeof rewritten !== "string")
		throw new TypeError("replyText must return a string");
	return rewritten;
}

/** Outranks the agent server's priority 100; ignored messages never fall through to host agents. */
export function sandboxClaim(options: SandboxClaimOptions): ChannelClaim {
	const owns = (channel: ChannelKey, space?: string): boolean =>
		options.channels.owns
			? options.channels.owns(channel, space)
			: options.channels.has(channel);
	// A message names its own guild; one without a space is a sandbox message only when its channel
	// was enabled by command, never because the channel was remembered from an earlier question.
	const admits = (message: InboundMessage): boolean =>
		message.space === undefined
			? options.channels.has(message.channel)
			: owns(message.channel, message.space);
	return {
		name: "sandbox",
		priority: 200,
		postsInPlace: true,
		owns,
		admit: (message) => {
			if (!admits(message) || !isSandboxAddress(message)) return undefined;
			// The router resolved the author; one the host's access rules serve no one by goes
			// unanswered, as does a message whose author it could not resolve.
			const { speaker } = message;
			if (!speaker) return undefined;
			return {
				kind: "turn",
				failure: "sandbox turn failed",
				run: async () => {
					// A queued turn rechecks mode, so an off command cannot send it to host tools.
					if (!admits(message)) return;
					const stopTyping = options.surfaces.startTyping(message.channel);
					try {
						const text = await contextualText(
							options,
							message,
							`${message.reference?.text ? `Quoted message (untrusted): ${message.reference.text}\n\n` : ""}${message.text}${message.attachments.length ? "\n[Attachments are not supported in this sandbox.]" : ""}`,
						);
						const reply = await options.runtime.runTurn(
							message.channel,
							{
								id: message.authorId,
								name: message.authorName,
								principalId: speaker.principalId,
							},
							text,
							{ space: message.space },
						);
						const posted = reply.ok
							? await rewriteReply(options.replyText, reply.text, message)
							: "The sandbox turn failed.";
						await options.surfaces.sendReply(message.channel, {
							chunks: splitReply(posted),
						});
					} catch (error) {
						// A stop or a full queue is the runtime working as designed, not a failure.
						if (!(error instanceof SandboxTurnRefused))
							options.reportFailure?.(message.channel, error);
						await options.surfaces.sendReply(message.channel, {
							chunks: ["The sandbox turn failed or was stopped."],
						});
					} finally {
						stopTyping();
					}
				},
			};
		},
		background: async () => ({
			status: "skipped",
			reason: "Background host turns are refused in sandbox channels.",
		}),
		stop: (channel) => options.runtime.stop(channel),
		startFresh: async (channel) => {
			options.runtime.startFresh(channel);
			return "sandbox";
		},
	};
}
