import { mkdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { type ChannelKey, definePlugin, serviceKey } from "pi-roundtable";
import { DISCORD } from "pi-roundtable/discord";
import {
	resolveChannelContextOptions,
	type SandboxChannelContext,
} from "./channel-context.ts";
import { SandboxChannelStore } from "./channel-store.ts";
import { type SandboxReplyText, sandboxClaim } from "./claim.ts";
import { sandboxCommands } from "./commands.ts";
import { SandboxRuntime, type SandboxRuntimeOptions } from "./runtime.ts";

export interface SandboxOptions
	extends Omit<SandboxRuntimeOptions, "apiKey" | "timeZone"> {
	/** Persistent, host-only file outside both mounted directories. */
	stateFile: string;
	/** Used only when stateFile does not yet exist. */
	initialChannels?: readonly ChannelKey[];
	/**
	 * Discord guild ids whose every channel and thread is a sandbox channel, with no
	 * `/roundtable sandbox on`; ids are validated at startup. A configured guild cannot be turned
	 * off by command. Direct messages and other guilds are not affected.
	 */
	guilds?: readonly string[];
	/** Host login provider used for each model call, unless apiKey is supplied. */
	provider?: string;
	/** Read before each model call with its channel and speaker; never falls back to the host login. */
	apiKey?: SandboxRuntimeOptions["apiKey"];
	/**
	 * Rewrites each successful model reply on the host before it is posted, for example to
	 * convert Simplified to Traditional Chinese. Failure texts are not passed to it; a throw
	 * fails the turn.
	 */
	replyText?: SandboxReplyText;
	/**
	 * Off by default. On, a turn in a Discord server channel starts with what others said in that
	 * channel since the assistant last posted, read through the Discord plugin's `channelContext`
	 * (`true` for its defaults, or its `ChannelContextOptions`; images are never read). The text is
	 * framed as untrusted public text and cut, oldest first, to fit the turn; a failed read runs the
	 * turn without it. Needs the Discord plugin. Host-only: no worker or image change.
	 */
	channelContext?: SandboxChannelContext;
}
export interface SandboxService {
	channels: SandboxChannelStore;
	runtime: SandboxRuntime;
}
export const SANDBOX = serviceKey<SandboxService>("sandbox.channels");

export function sandbox(options: SandboxOptions) {
	return definePlugin({
		name: "sandbox",
		provides: [SANDBOX],
		setup: async (context) => {
			const contextOptions =
				options.channelContext === undefined
					? undefined
					: resolveChannelContextOptions(options.channelContext);
			const discord = context.services.find(DISCORD);
			if (contextOptions && !discord)
				throw new Error("sandbox channelContext needs the Discord plugin");
			const runtime = new SandboxRuntime({
				...options,
				apiKey:
					options.apiKey ??
					(() => context.apiKey(options.provider ?? "openai")),
				timeZone: context.env.timeZone,
			});
			if (!isAbsolute(options.stateFile))
				throw new Error("stateFile must be absolute");
			mkdirSync(dirname(options.stateFile), { recursive: true, mode: 0o700 });
			const stateFile = resolve(
				realpathSync(dirname(options.stateFile)),
				options.stateFile.split("/").at(-1) ?? "",
			);
			for (const root of [
				realpathSync(options.runRoot),
				realpathSync(options.workspaceRoot),
			]) {
				if (stateFile === root || stateFile.startsWith(`${root}/`))
					throw new Error("routing state must stay outside sandbox mounts");
			}
			const channels = new SandboxChannelStore(
				stateFile,
				options.initialChannels,
				{ guilds: options.guilds },
			);
			// Last of the cheap checks: a typo above fails fast, without a `docker inspect`.
			await runtime.verifyImage();
			context.services.provide(SANDBOX, { channels, runtime });
			if (discord)
				discord.commands.add(
					sandboxCommands(discord.guard, channels, context.queue),
				);
			return {
				channels: [
					sandboxClaim({
						channels,
						runtime,
						surfaces: context.surfaces,
						...(options.replyText ? { replyText: options.replyText } : {}),
						...(contextOptions && discord
							? {
									channelContext: (message) =>
										discord.channelContext(message, contextOptions),
									reportContextFailure: (channel, error) =>
										context.logger.warn(
											{ channel, err: error },
											"sandbox channel context not read; the turn runs without it",
										),
								}
							: {}),
						reportFailure: (channel, error) =>
							context.logger.error(
								{ channel, err: error },
								"sandbox turn failed; inspect the error, then container cleanup, broker configuration and replyText",
							),
					}),
				],
				services: [
					{
						name: "sandbox-runtime",
						busy: () => runtime.busy(),
						stop: () => runtime.dispose(),
					},
				],
			};
		},
	});
}
