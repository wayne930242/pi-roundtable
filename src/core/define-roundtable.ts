import { readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
	type AgentServerOptions,
	agentServerPlugin,
} from "./builtin/agent-server.ts";
import { discordPlugin } from "./builtin/discord.ts";
import {
	type ModulesOptions,
	modulesPlugin,
	schedulerPlugin,
} from "./builtin/modules.ts";
import { seedsPlugin } from "./builtin/seeds.ts";
import { storesPlugin } from "./builtin/stores.ts";
import { type RoundtableConfig, resolveConfig } from "./config/config.ts";
import { ownerRootCommand } from "./discord/owner-command.ts";
import { ConfigError } from "./domain/errors.ts";
import { JudgeError } from "./errors.ts";
import type { RoundtableOptions } from "./host.ts";
import { setLocale } from "./i18n/index.ts";
import { type JudgeModel, piJudgeModel } from "./judging/model-judge.ts";
import { createLogger, type Logger } from "./log.ts";
import { formatModelRef, type ModelRef } from "./models.ts";
import { ErrorReporter } from "./ops/error-reporter.ts";
import type { RoundtablePlugin } from "./plugin.ts";
import { speakerPolicy } from "./speakers.ts";
import { setTimeZone } from "./time.ts";
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
	/** Your own logger and error reporter, when the process already has them. */
	logger?: Logger;
	errorReporter?: ErrorReporter;
	/** Host options merged over the built ones, such as more listeners or the record of aborted work. */
	options?: Partial<RoundtableOptions>;
	/** What only the plugins after the built-ins can know. */
	modules?: Pick<ModulesOptions, "agentChannelOf">;
	agentServer?: Pick<AgentServerOptions, "ownerSessions">;
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
		return await piJudgeModel(modelRuntime, model)(system, prompt);
	};
}

/**
 * The host's options and the plugin list of a configured bot: the built-in plugins in their
 * fixed order, then the operator's, then the scheduler, so a due schedule fires only once
 * everything it reaches runs. Configuration mistakes stop here, naming the key and the fix.
 */
export async function defineRoundtable(
	input: RoundtableConfig,
	overrides: DefineOverrides = {},
): Promise<DefinedRoundtable> {
	const config = resolveConfig(input);
	const { name, owner, discord } = config;
	setLocale(config.locale, { assistant: name, root: discord.rootCommand });
	setTimeZone(config.timeZone);
	// Pi packages such as pi-web-access read their config from the Pi agent directory.
	process.env.PI_CODING_AGENT_DIR = config.agentDir;
	const modelRuntime =
		overrides.modelRuntime ??
		(await ModelRuntime.create({
			authPath: join(config.agentDir, "auth.json"),
		}));
	const errorReporter =
		overrides.errorReporter ??
		(config.ops
			? new ErrorReporter({ opsAgent: config.ops.agent, app: name })
			: undefined);
	const logger =
		overrides.logger ??
		createLogger(
			discord.rootCommand,
			errorReporter ? (entry) => errorReporter.record(entry) : undefined,
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
	return {
		options: {
			logger,
			database: { url: config.databaseUrl },
			toolTiers: toolTiers(config.toolTiers),
			commands: { root: ownerRootCommand(discord.rootCommand) },
			listeners: [
				config.http.socketPath
					? { id: "public", socketPath: config.http.socketPath }
					: {
							id: "public",
							port: config.http.port,
							...(config.http.hostname
								? { hostname: config.http.hostname }
								: {}),
						},
			],
			judgeModel: judgeThrough(modelRuntime, config.judge.model),
			...overrides.options,
		},
		plugins: [
			storesPlugin({ ownerId: owner.id, guildId: discord.guild }),
			discordPlugin({
				token: discord.token,
				ownerId: owner.id,
				ownerName: owner.name,
				speakers,
				rootCommand: discord.rootCommand,
				dataDir: config.dataDir,
				avatarUrl: config.http.publicUrl,
				avatarReference: config.avatar ?? join(ASSETS, "neutral.png"),
			}),
			modulesPlugin({
				owner,
				assistant: name,
				modelRuntime,
				agentDir: config.agentDir,
				dataDir: config.dataDir,
				delegation: config.delegation,
				...overrides.modules,
			}),
			agentServerPlugin({
				guildId: discord.guild,
				entryChannelId: discord.entryChannel,
				owner,
				assistant: name,
				speakers,
				modelRuntime,
				agentDir: config.agentDir,
				dataDir: config.dataDir,
				model: config.model,
				thinking: config.thinking,
				judgeThreshold: config.judge.threshold,
				workDir: config.workDir,
				shellUser: userInfo().username,
				prompts: { shared, guest },
				skills: {
					reposDir: config.skills.reposDir ?? join(config.dataDir, "repos"),
					writtenDir: join(config.dataDir, "skills"),
					builtinDir: config.skills.builtinDir ?? join(ASSETS, "skills"),
				},
				avatarListener: "public",
				...(errorReporter ? { errorReporter } : {}),
				...overrides.agentServer,
			}),
			seedsPlugin(config.agents),
			...config.plugins,
			schedulerPlugin(),
		],
	};
}
