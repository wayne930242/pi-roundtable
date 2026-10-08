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
import { warnDeprecations } from "./config/access.ts";
import {
	type ResolvedConfig,
	type RoundtableConfig,
	resolveConfig,
} from "./config/config.ts";
import { conversationsPlugin } from "./conversations/conversations-plugin.ts";
import { ConfigError } from "./domain/errors.ts";
import { JudgeError } from "./errors.ts";
import type { RoundtableOptions } from "./host.ts";
import type { ListenerConfig } from "./http/listeners.ts";
import { identityPlugin } from "./identity/identity-plugin.ts";
import { type JudgeModel, piJudgeModel } from "./judging/model-judge.ts";
import { createLogger, type LogEntry, type Logger } from "./log.ts";
import { formatModelRef, type ModelRef } from "./models.ts";
import { ErrorReporter } from "./ops/error-reporter.ts";
import type { RoundtablePlugin } from "./plugin.ts";
import {
	type AgentSessionsSlot,
	agentSessionsSlot,
	runtimePlugin,
} from "./runtime/runtime-plugin.ts";
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
	http: NonNullable<ResolvedConfig["http"]>,
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
 * The owner the Discord parts act for: the primary owner, by the Discord user id among their
 * identities, until those parts follow each turn's principal.
 */
export function discordOwnerOf(
	config: ResolvedConfig,
): ResolvedConfig["owner"] {
	return {
		...config.owner,
		id: config.primaryOwner.discordId ?? config.owner.id,
	};
}

/** The Discord bot and the agent server that lives there, each in its place in the plugin list. */
interface DiscordAssembly {
	discord: RoundtablePlugin;
	admin: RoundtablePlugin[];
	skills: RoundtablePlugin[];
	agentServer: RoundtablePlugin;
	seeds: RoundtablePlugin;
}

function discordAssembly(
	config: ResolvedConfig,
	discord: NonNullable<ResolvedConfig["discord"]>,
	shared: {
		modelRuntime: ModelRuntime;
		agentSessions: AgentSessionsSlot;
		errorReporter: ErrorReporter | undefined;
	},
): DiscordAssembly {
	const { name } = config;
	const owner = discordOwnerOf(config);
	const sharedPrompt = config.prompts.shared
		? readPrompt(config.prompts.shared, "prompts.shared")
		: readPrompt(join(ASSETS, "prompts", "shared.md"), "prompts.shared");
	const guest = config.prompts.guest
		? readPrompt(config.prompts.guest, "prompts.guest")
		: readPrompt(join(ASSETS, "prompts", "shared-guest.md"), "prompts.guest");
	const { errorReporter } = shared;
	return {
		discord: discordPlugin({
			token: discord.token,
			ownerId: owner.id,
			ownerName: owner.name,
			rootCommand: discord.rootCommand,
			dataDir: config.dataDir,
			...(discord.refusalHint === undefined
				? {}
				: { refusalHint: discord.refusalHint }),
		}),
		admin: discord.admin ? [discordAdminPlugin({ owner })] : [],
		skills: config.skills
			? [
					skillsPlugin({
						guildId: discord.guild,
						reposDir: config.skills.reposDir ?? join(config.dataDir, "repos"),
						writtenDir: join(config.dataDir, "skills"),
						builtinDir: config.skills.builtinDir ?? join(ASSETS, "skills"),
					}),
				]
			: [],
		agentServer: agentServerPlugin({
			guildId: discord.guild,
			entryChannelId: discord.entryChannel,
			owner,
			assistant: name,
			modelRuntime: shared.modelRuntime,
			dataDir: config.dataDir,
			model: config.model,
			judgeThreshold: config.judge.threshold,
			agents: shared.agentSessions,
			workDir: config.workDir,
			scratchDir: config.scratchDir,
			shellUser: userInfo().username,
			prompts: { shared: sharedPrompt, guest },
			avatarListener: "public",
			// resolveConfig refuses Discord without a public address.
			avatarUrl: config.http?.publicUrl ?? "",
			avatarReference: config.avatar ?? join(ASSETS, "neutral.png"),
			// An ops agent's reports are the agent server's to deliver.
			...(errorReporter && "agent" in errorReporter.destination
				? { errorReporter }
				: {}),
		}),
		seeds: seedsPlugin(config.agents),
	};
}

/**
 * The host's options and the plugin list of a configured bot: the built-in plugins in their
 * fixed order (each service one provides is read by the ones after it), then the operator's, then the scheduler, so a due schedule fires only once
 * everything it reaches runs. The memory, Discord administration, and skills addons are left out
 * when the configuration switches them off. Without `discord` the Discord plugins, the skills,
 * the agent server and its seeds are left out, and the runtime still runs every turn of
 * `context.turns`. Configuration mistakes stop here, naming the key and the fix.
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
		? new ErrorReporter({ destination: config.ops, app: name })
		: undefined;
	const { errorSink } = overrides;
	const logger =
		overrides.logger ??
		createLogger(
			config.slug,
			errorReporter || errorSink
				? (entry) => {
						errorReporter?.record(entry);
						errorSink?.(entry);
					}
				: undefined,
		);
	warnDeprecations(logger, config.deprecations);
	// The agent server hands the runtime its per-agent settings once it sets up.
	const agentSessions = agentSessionsSlot();
	const assembly = discord
		? discordAssembly(config, discord, {
				modelRuntime,
				agentSessions,
				errorReporter,
			})
		: undefined;
	return {
		options: {
			logger,
			environment: {
				locale: config.locale,
				timeZone: config.timeZone,
				assistant: name,
				rootCommand: config.slug,
				agentDir: config.agentDir,
			},
			database: { url: config.databaseUrl },
			toolTiers: toolTiers(config.toolTiers, logger),
			listeners: [
				...(config.http ? [publicListener(config.http)] : []),
				...(overrides.listeners ?? []),
			],
			judgeModel: judgeThrough(modelRuntime, config.judge.model),
			apiKey: (provider) => registry.getApiKeyForProvider(provider),
			...(overrides.aborted ? { aborted: overrides.aborted } : {}),
		},
		plugins: [
			identityPlugin({ rules: config.access, plugins: config.plugins }),
			...(config.memory ? [memoryPlugin({ owner })] : []),
			scheduleStorePlugin(),
			precheckPlugin(),
			...(assembly ? [assembly.discord] : []),
			modulesPlugin({
				owner,
				assistant: name,
				modelRuntime,
				agentDir: config.agentDir,
				dataDir: config.dataDir,
				delegation: config.delegation,
				perPrincipal: config.background.perPrincipal,
				// A conversation's reports are the modules' to deliver.
				...(errorReporter && "conversation" in errorReporter.destination
					? { errorReporter }
					: {}),
			}),
			...(assembly?.admin ?? []),
			...(assembly?.skills ?? []),
			conversationsPlugin(),
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
			...(assembly ? [assembly.agentServer, assembly.seeds] : []),
			...config.plugins,
			schedulerPlugin(),
		],
	};
}
