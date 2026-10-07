import { mkdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { type ChannelKey, definePlugin, serviceKey } from "pi-roundtable";
import { DISCORD } from "pi-roundtable/discord";
import { SandboxChannelStore } from "./channel-store.ts";
import { sandboxClaim } from "./claim.ts";
import { sandboxCommands } from "./commands.ts";
import { SandboxRuntime, type SandboxRuntimeOptions } from "./runtime.ts";

export interface SandboxOptions
	extends Omit<SandboxRuntimeOptions, "apiKey" | "timeZone"> {
	/** Persistent, host-only file outside both mounted directories. */
	stateFile: string;
	/** Used only when stateFile does not yet exist. */
	initialChannels?: readonly ChannelKey[];
	/** Host login provider used for each model call, unless apiKey is supplied. */
	provider?: string;
	/** Read before each model call with its channel and speaker; never falls back to the host login. */
	apiKey?: SandboxRuntimeOptions["apiKey"];
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
		setup: (context) => {
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
			);
			context.services.provide(SANDBOX, { channels, runtime });
			const discord = context.services.find(DISCORD);
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
						reportFailure: (channel) =>
							context.logger.error(
								{ channel },
								"sandbox turn failed; inspect container cleanup and broker configuration",
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
