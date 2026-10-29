import type {
	ChannelClaim,
	ChannelKey,
	InboundMessage,
	SurfacePort,
} from "pi-roundtable";
import { splitReply } from "pi-roundtable/kit";
import type { SandboxChannelStore } from "./channel-store.ts";
import type { SandboxRuntime } from "./runtime.ts";

export interface SandboxClaimOptions {
	/** `owns` adds channels in configured guilds; without it only `has` decides. */
	channels: Pick<SandboxChannelStore, "has"> &
		Partial<Pick<SandboxChannelStore, "owns">>;
	runtime: Pick<SandboxRuntime, "runTurn" | "stop" | "startFresh">;
	surfaces: Pick<SurfacePort, "sendReply" | "startTyping">;
	reportFailure?: (channel: ChannelKey) => void;
}

export function isSandboxAddress(message: InboundMessage): boolean {
	return (
		!message.authorIsBot &&
		!message.integration &&
		!message.isDirect &&
		(message.mentionsBot || message.repliesToBot)
	);
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
						const text = `${message.reference?.text ? `Quoted message (untrusted): ${message.reference.text}\n\n` : ""}${message.text}${message.attachments.length ? "\n[Attachments are not supported in this sandbox.]" : ""}`;
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
						await options.surfaces.sendReply(message.channel, {
							chunks: splitReply(
								reply.ok ? reply.text : "The sandbox turn failed.",
							),
						});
					} catch {
						options.reportFailure?.(message.channel);
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
