import { readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { agentServerPlugin } from "./builtin/agent-server.ts";
import { discordPlugin } from "./builtin/discord.ts";
import { discordAdminPlugin } from "./builtin/discord-admin.ts";
import { modulesPlugin, schedulerPlugin } from "./builtin/modules.ts";
import { seedsPlugin } from "./builtin/seeds.ts";
import { skillsPlugin } from "./builtin/skills.ts";
import {
	memoryPlugin,
	precheckPlugin,
	scheduleStorePlugin,
} from "./builtin/stores.ts";
import { type RoundtableConfig, resolveConfig } from "./config/config.ts";
import { ConfigError } from "./domain/errors.ts";
import { JudgeError } from "./errors.ts";
import type { RoundtableOptions } from "./host.ts";
import type { ListenerConfig } from "./http/listeners.ts";
import { type JudgeModel, piJudgeModel } from "./judging/model-judge.ts";
import { createLogger, type LogEntry, type Logger } from "./log.ts";
import { formatModelRef, type ModelRef } from "./models.ts";
import { ErrorReporter } from "./ops/error-reporter.ts";
import type { RoundtablePlugin } from "./plugin.ts";
import { agentSessionsSlot, runtimePlugin } from "./runtime/runtime-plugin.ts";
import { speakerPolicy } from "./speakers.ts";
import { toolTiers } from "./tool-tiers.ts";

/** What `defineRoundtable` returns: give both to `new Roundtable(options, plugins)`. */
export interface DefinedRoundtable {
	options: RoundtableOptions;
	plugins: RoundtablePlugin[];
}

/** Replaceable parts of the assembly, for a host that shares them with its own plugins. */
export interface DefineOverrides {
	/** The model login the process shares; by default one is opened in the agent directory. */
	modelRuntime?: ModelRuntime;
	/**
	 * Your own logger, when the process already has one. The host reports errors to `config.ops`'s
	 * agent and to `errorSink` from the logger it builds, so a logger given here forwards its own
	 * error lines to them if it should.
	 */
	logger?: Logger;
	/**
	 * Also receives every `error` and `fatal` log line of the logger the host builds, after the ops
	 * agent's report. It must not throw.
	 */
	errorSink?: (entry: LogEntry) => void;
	/** More HTTP listeners than the one `config.http` names, each with its own id. */
	listeners?: readonly ListenerConfig[];
	/** Receives the work a shutdown drain gave up on, before any service stops. */
	aborted?: (left: string[]) => Promise<void>;
}

const ASSETS = join(import.meta.dir, "assets");

function readPrompt(path: string, key: string): string {
	let text: string;
	try {
		text = readFileSync(path, "utf8").trim();
	} catch (error) {
		throw new ConfigError(
			`config ${key}: cannot read ${path}: ${error instanceof Error ? error.message : String(error)}. Create the file or fix the path.`,
		);
	}
	if (text === "")
		throw new ConfigError(
			`config ${key}: ${path} is empty. Write the prompt in it.`,
		);
	return text;
}

/** The judge's completion through the shared login, resolving the model when first asked. */
function judgeThrough(modelRuntime: ModelRuntime, ref: ModelRef): JudgeModel {
	const registry = new ModelRegistry(modelRuntime);
	return async (system, prompt) => {
		const model = registry.find(ref.provider, ref.id);
		if (!model)
			throw new JudgeError(
				`the judge's model ${formatModelRef(ref)} is not available; log in to its provider or change judge.model`,
			);
		return piJudgeModel(modelRuntime, model)(system, prompt);
	};
}

/** The listener `config.http` names: its unix socket when it has one, else its TCP port. */
function publicListener(
	http: ReturnType<typeof resolveConfig>["http"],
): ListenerConfig {
	if (http.socketPath)
		return {
			id: "public",
			socketPath: http.socketPath,
			...(http.socketMode === undefined ? {} : { mode: http.socketMode }),
		};
	return {
		id: "public",
		port: http.port,
		...(http.hostname ? { hostname: http.hostname } : {}),
	};
}

/**
 * The host's options and the plugin list of a configured bot: the built-in plugins in their
 * fixed order (each service one provides is read by the ones after it), then the operator's, then the scheduler, so a due schedule fires only once
 * everything it reaches runs. The memory, Discord administration, and skills addons are left out
 * when the configuration switches them off. Configuration mistakes stop here, naming the key and the fix.
 */
export async function defineRoundtable(
	input: RoundtableConfig,
	overrides: DefineOverrides = {},
): Promise<DefinedRoundtable> {
	const config = resolveConfig(input);
	const { name, owner, discord } = config;
	// Nothing here touches the process: the host applies the environment when it runs.
	const modelRuntime =
		overrides.modelRuntime ??
		(await ModelRuntime.create({
			authPath: join(config.agentDir, "auth.json"),
			modelsPath: join(config.agentDir, "models.json"),
		}));
	const registry = new ModelRegistry(modelRuntime);
	const errorReporter = config.ops
		? new ErrorReporter({ opsAgent: config.ops.agent, app: name })
		: undefined;
	const { errorSink } = overrides;
	const logger =
		overrides.logger ??
		createLogger(
			discord.rootCommand,
			errorReporter || errorSink
				? (entry) => {
						errorReporter?.record(entry);
						errorSink?.(entry);
					}
				: undefined,
		);
	const speakers = speakerPolicy({
		owners: [owner.id],
		...(config.speakers.admins ? { admins: config.speakers.admins } : {}),
		...(config.speakers.members ? { members: config.speakers.members } : {}),
	});
	const shared = config.prompts.shared
		? readPrompt(config.prompts.shared, "prompts.shared")
		: readPrompt(join(ASSETS, "prompts", "shared.md"), "prompts.shared");
	const guest = config.prompts.guest
		? readPrompt(config.prompts.guest, "prompts.guest")
		: readPrompt(join(ASSETS, "prompts", "shared-guest.md"), "prompts.guest");
	// The agent server hands the runtime its per-agent settings once it sets up.
	const agentSessions = agentSessionsSlot();
	return {
		options: {
			logger,
			environment: {
				locale: config.locale,
				timeZone: config.timeZone,
				assistant: name,
				rootCommand: discord.rootCommand,
				agentDir: config.agentDir,
			},
			database: { url: config.databaseUrl },
			toolTiers: toolTiers(config.toolTiers),
			listeners: [publicListener(config.http), ...(overrides.listeners ?? [])],
			judgeModel: judgeThrough(modelRuntime, config.judge.model),
			apiKey: (provider) => registry.getApiKeyForProvider(provider),
			...(overrides.aborted ? { aborted: overrides.aborted } : {}),
		},
		plugins: [
			...(config.memory ? [memoryPlugin({ owner })] : []),
			scheduleStorePlugin(),
			precheckPlugin(),
			discordPlugin({
				token: discord.token,
				ownerId: owner.id,
				ownerName: owner.name,
				speakers,
				rootCommand: discord.rootCommand,
				dataDir: config.dataDir,
				...(discord.refusalHint === undefined
					? {}
					: { refusalHint: discord.refusalHint }),
			}),
			modulesPlugin({
				owner,
				assistant: name,
				modelRuntime,
				agentDir: config.agentDir,
				dataDir: config.dataDir,
				delegation: config.delegation,
			}),
			...(discord.admin ? [discordAdminPlugin({ owner })] : []),
			...(config.skills
				? [
						skillsPlugin({
							guildId: discord.guild,
							reposDir: config.skills.reposDir ?? join(config.dataDir, "repos"),
							writtenDir: join(config.dataDir, "skills"),
							builtinDir: config.skills.builtinDir ?? join(ASSETS, "skills"),
						}),
					]
				: []),
			runtimePlugin({
				owner,
				modelRuntime,
				agentDir: config.agentDir,
				dataDir: config.dataDir,
				model: config.model,
				thinking: config.thinking,
				judgeThreshold: config.judge.threshold,
				agents: agentSessions,
				interimText: config.interimText,
				interimPrimaryChars: config.interimPrimaryChars,
			}),
			agentServerPlugin({
				guildId: discord.guild,
				entryChannelId: discord.entryChannel,
				owner,
				assistant: name,
				speakers,
				modelRuntime,
				dataDir: config.dataDir,
				model: config.model,
				judgeThreshold: config.judge.threshold,
				agents: agentSessions,
				workDir: config.workDir,
				scratchDir: config.scratchDir,
				shellUser: userInfo().username,
				prompts: { shared, guest },
				avatarListener: "public",
				avatarUrl: config.http.publicUrl,
				avatarReference: config.avatar ?? join(ASSETS, "neutral.png"),
				...(errorReporter ? { errorReporter } : {}),
			}),
			seedsPlugin(config.agents),
			...config.plugins,
			schedulerPlugin(),
		],
	};
}
