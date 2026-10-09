import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSeed } from "../agents/agent-rules.ts";
import { ConfigError } from "../domain/errors.ts";
import type { InterimTextMode } from "../domain/interim.ts";
import { isLocale, type Locale } from "../i18n/index.ts";
import type { AccessRules } from "../identity/access-policy.ts";
import type { OwnerIdentity } from "../identity.ts";
import {
	type ModelRef,
	parseModelRef,
	THINKING_LEVELS,
	type ThinkingLevel,
} from "../models.ts";
import type { PerPrincipalLimits } from "../modules/background/personal-target.ts";
import type { RoundtablePlugin } from "../plugin.ts";
import { PRIMARY_CHARS } from "../runtime/interim-text.ts";
import type { ChannelKey } from "../sessions.ts";
import type { Tier, TierMembers } from "../speakers.ts";
import { type AccessConfig, accessOf, accessShape } from "./access.ts";
import { type DiscordConfig, discordShape, liftAdapters } from "./adapters.ts";
import {
	bool,
	guarded,
	integer,
	list,
	number,
	oneOf,
	optional,
	orOff,
	record,
	shape,
	text,
} from "./schema.ts";

export type { DiscordConfig };

/** How prompts refer back to the owner. */
export type Pronouns = "he" | "she" | "they";

/**
 * Who holds a tier besides the owner: user ids, role ids, or everyone. `everyone` works under any
 * tier it is written in, so under `admins` it makes every author an admin.
 */
export interface TierConfig {
	users?: readonly string[];
	roles?: readonly string[];
	everyone?: boolean;
}

/** A chat network the host talks through, as its adapter's factory makes it; `adapter` names the network. */
export interface AdapterConfig {
	readonly adapter: string;
}

/** What `discord()` from `pi-roundtable/discord` makes: the Discord settings under the adapter's name. */
export interface DiscordAdapterConfig extends AdapterConfig {
	readonly adapter: "discord";
	readonly discord: DiscordConfig;
}

/** The configuration's `background`: each person's share of the host's background work. */
export interface BackgroundConfig {
	perPrincipal?: PerPrincipalLimits;
}

/** What `roundtable.config.ts` gives `defineRoundtable`. */
export interface RoundtableConfig {
	/** The assistant's display name; default "Roundtable". */
	name?: string;
	/**
	 * The one owner, as 0.8 wrote it: their id, which is both their principal and their Discord
	 * user id, their name, and pronouns. Deprecated, going away in 0.10: write `access` instead,
	 * never both; `roundtable upgrade` rewrites it.
	 */
	owner?: { id: string; name: string; pronouns?: Pronouns };
	/**
	 * The Discord bot, its guild, and the agent server that lives there. Leave it out for a host
	 * without Discord: no Discord plugins, no agent server or agents, no skills, and no tool that
	 * messages the owner on Discord; conversations come through the plugins' own surfaces. The same
	 * settings may come as `adapters: [discord({...})]` instead, never both.
	 */
	discord?: DiscordConfig;
	/**
	 * The chat networks the host talks through, each made by its adapter's factory, such as
	 * `discord()` from `pi-roundtable/discord`. A Discord adapter is the same as the top-level
	 * `discord`; a chat network that comes as a plugin, such as pi-roundtable-webchat, stays in
	 * `plugins`.
	 */
	adapters?: readonly AdapterConfig[];
	database: { url: string };
	/** Where the process keeps its files, such as pictures, attachments, and skills. */
	dataDir: string;
	/** Pi's agent directory, holding the model logins; default `<dataDir>/pi`. */
	agentDir?: string;
	/** The model of the agents, written `<provider>/<id>`. */
	model: string;
	/** The level a turn thinks at when its judge cannot pick; default "medium". */
	thinking?: ThinkingLevel;
	/** The model that judges small questions and the delegated tasks' model; default the agents' model. */
	judge?: { model?: string; threshold?: number };
	delegation?: { model?: string; thinking?: ThinkingLevel };
	/** The language of what the bot shows in Discord; default "en". */
	locale?: Locale;
	/** The IANA time zone schedules and stamps use; default "UTC". */
	timeZone?: string;
	/** Who may talk to the agents besides the owner, by Discord user and role ids, as 0.8 wrote it. Deprecated with `owner`: write `access` instead. */
	speakers?: { admins?: TierConfig; members?: TierConfig };
	/**
	 * Who the host serves: the owners, the first the primary one, and the admins and members by
	 * identity (`<provider>:<subject>`), role (`<surface>:role:<name>`), or everyone. Required
	 * unless the deprecated `owner` is given, and never with it.
	 */
	access?: AccessConfig;
	/**
	 * Each person's limits across all their conversations: `perPrincipal.schedules` they may keep and
	 * `perPrincipal.delegations` running at once. Unset, only each conversation's, as in 0.8.
	 */
	background?: BackgroundConfig;
	toolTiers?: Record<string, Tier>;
	/** Prompt files, read once at start; `shared` starts every agent's prompt. */
	prompts?: { shared: string; guest?: string };
	/** The first team, created once; an agent already stored is never overwritten. Needs `discord`. */
	agents?: AgentSeed[];
	/**
	 * The `public` listener: the public address that reaches it, and the TCP port (default 3000) or
	 * unix socket the process listens on. `socketMode` is the socket file's permission bits
	 * (default `0o660`); widen it only for a proxy that runs as another user. With `discord` it is
	 * required, with `publicUrl`, the address the agents' avatars are served from; without
	 * `discord` leave it out when no plugin serves HTTP, and the host opens no listener.
	 */
	http?: {
		publicUrl?: string;
		port?: number;
		hostname?: string;
		socketPath?: string;
		socketMode?: number;
	};
	/** A picture of your own for agents without one, and the style reference for drawing them; default a plain bot. */
	avatar?: string;
	/** The agents' shared working directory; default `<dataDir>/work`. */
	workDir?: string;
	/**
	 * The agents' scratch dir: their shell runs with TMPDIR pointing to it, and writes and removals
	 * inside it run without a hold. Default `<os temp dir>/<slug>-scratch`, where the slug is
	 * `discord.rootCommand`, or the lowercase assistant name without Discord.
	 */
	scratchDir?: string;
	/**
	 * Where the skill registry reads built-in skills and keeps linked repositories. `false` leaves
	 * the `skills` addon out: agents carry no skills, and no skill tools exist. Stored skills stay
	 * in their tables. Without `discord` there are no agents, so the addon is off.
	 */
	skills?: false | { builtinDir?: string; reposDir?: string };
	/**
	 * Whether each speaker's memory is kept and offered as tools; default true. `false` leaves the
	 * `memory` addon out: no memory tools, no memory prompt block, and the table stays as it is.
	 */
	memory?: boolean;
	/**
	 * Where the process's own errors are reported: to an agent, by name, in its channel (needs
	 * `discord`), or to a conversation, by its key `<surface>:<id>`, as a visible message and a
	 * report turn its claim answers. The host does not start when no chat surface serves the
	 * conversation or no plugin's claim owns it; the web chat takes no error reports.
	 */
	ops?: { agent: string } | { conversation: string };
	/**
	 * Whether a turn posts the text it writes before its final answer as it goes: long or
	 * structured text as ordinary messages, short narration and the tools called in one small
	 * progress message. Default "on"; "off" posts only the final reply.
	 */
	interimText?: InterimTextMode;
	/** An intermediate text this long or longer is posted as an ordinary message; default 400. */
	interimPrimaryChars?: number;
	plugins?: RoundtablePlugin[];
}

const tierMembers = shape({
	users: optional(list(text)),
	roles: optional(list(text)),
	everyone: optional(bool),
});

const isPlugin = (value: unknown): value is RoundtablePlugin =>
	typeof value === "object" &&
	value !== null &&
	typeof (value as { name?: unknown }).name === "string" &&
	typeof (value as { setup?: unknown }).setup === "function";

const schema = shape({
	name: optional(text),
	owner: optional(
		shape({
			id: text,
			name: text,
			pronouns: optional(oneOf<Pronouns>("he", "she", "they")),
		}),
	),
	discord: optional(discordShape),
	database: shape({ url: text }),
	dataDir: text,
	agentDir: optional(text),
	model: text,
	thinking: optional(oneOf(...THINKING_LEVELS)),
	judge: optional(
		shape({ model: optional(text), threshold: optional(number(0, 1)) }),
	),
	delegation: optional(
		shape({
			model: optional(text),
			thinking: optional(oneOf(...THINKING_LEVELS)),
		}),
	),
	locale: optional(
		guarded("a locale, en or zh-TW", (value): value is Locale =>
			isLocale(value),
		),
	),
	timeZone: optional(text),
	speakers: optional(
		shape({ admins: optional(tierMembers), members: optional(tierMembers) }),
	),
	access: optional(accessShape),
	background: optional(
		shape({
			perPrincipal: optional(
				shape({
					schedules: optional(integer(1, 10_000)),
					delegations: optional(integer(1, 1_000)),
				}),
			),
		}),
	),
	toolTiers: optional(record(oneOf<Tier>("owner", "admin", "member"))),
	prompts: optional(shape({ shared: text, guest: optional(text) })),
	agents: optional(
		list(
			shape({
				name: text,
				displayName: text,
				prompt: text,
				avatarPrompt: text,
				channelId: optional(text),
			}),
		),
	),
	http: optional(
		shape({
			publicUrl: optional(text),
			port: optional(integer(1, 65535)),
			hostname: optional(text),
			socketPath: optional(text),
			socketMode: optional(integer(0, 0o777)),
		}),
	),
	avatar: optional(text),
	workDir: optional(text),
	scratchDir: optional(text),
	skills: optional(
		orOff(shape({ builtinDir: optional(text), reposDir: optional(text) })),
	),
	memory: optional(bool),
	ops: optional(shape({ agent: optional(text), conversation: optional(text) })),
	interimText: optional(oneOf<InterimTextMode>("on", "off")),
	interimPrimaryChars: optional(integer(1, 100_000)),
	plugins: optional(
		list(
			guarded("a plugin, an object with a name and a setup function", isPlugin),
		),
	),
});

/** The configuration with every default filled in. */
export interface ResolvedConfig {
	name: string;
	/**
	 * The process's short name: the logger's and the scratch dir's, and the root slash command's
	 * with Discord. `discord.rootCommand` when Discord is on, else the lowercase assistant name.
	 */
	slug: string;
	/**
	 * The primary owner, `access.owners[0]` (or the 0.8 `owner`): their principal id, name, and
	 * pronouns, and the Discord user id the Discord parts act for until 0.10.
	 */
	primaryOwner: OwnerIdentity & { id: string; discordId?: string };
	/** The primary owner as 0.8 knew them, `id` their principal id. Deprecated: read `primaryOwner`. */
	owner: OwnerIdentity & { id: string };
	/** Who the host serves, the 0.8 `owner` and `speakers` converted when they are what the configuration gives. */
	access: AccessRules;
	/** What the configuration wrote in a deprecated form, which the host logs once. */
	deprecations: string[];
	/** Undefined on a host without Discord. */
	discord?: {
		token: string;
		guild: string;
		entryChannel: string;
		rootCommand: string;
		admin: boolean;
		refusalHint?: string;
		agentMemory?: "everyone" | "owners";
		/** As configured: `{}` when left out, so the defaults apply, or `false`. */
		channelContext: NonNullable<DiscordConfig["channelContext"]>;
		freshMarker?: string | false;
	};
	databaseUrl: string;
	dataDir: string;
	agentDir: string;
	model: ModelRef;
	thinking: ThinkingLevel;
	judge: { model: ModelRef; threshold: number };
	delegation: { model: ModelRef; thinking: ThinkingLevel };
	locale: Locale;
	timeZone: string;
	/** The 0.8 `speakers`; empty when the configuration writes `access`. Deprecated: read `access`. */
	speakers: { admins?: TierMembers; members?: TierMembers };
	/** Each person's limits across their conversations; a limit left out is unset. */
	background: { perPrincipal: PerPrincipalLimits };
	toolTiers: Record<string, Tier>;
	prompts: { shared?: string; guest?: string };
	agents: AgentSeed[];
	/** Undefined when no `http` is configured, and the host opens no `public` listener. */
	http?: {
		/** Always set with Discord. */
		publicUrl?: string;
		port: number;
		hostname?: string;
		socketPath?: string;
		socketMode?: number;
	};
	avatar?: string;
	workDir: string;
	scratchDir: string;
	/** `false` when the skills addon is off. */
	skills: false | { builtinDir?: string; reposDir?: string };
	memory: boolean;
	ops?: { agent: string } | { conversation: ChannelKey };
	interimText: InterimTextMode;
	interimPrimaryChars: number;
	plugins: RoundtablePlugin[];
}

function modelOf(value: string, path: string): ModelRef {
	const parsed = parseModelRef(value);
	if (!parsed)
		throw new ConfigError(
			`config ${path}: expected <provider>/<id>, got ${JSON.stringify(value)}. Write it like anthropic/claude-sonnet-5-5.`,
		);
	return parsed;
}

/** Where the errors go: one of an agent or a conversation; an agent only where the agents live. */
function opsOf(
	ops: { agent?: string; conversation?: string } | undefined,
	withDiscord: boolean,
): ResolvedConfig["ops"] {
	if (!ops) return undefined;
	const { agent, conversation } = ops;
	if (agent !== undefined && conversation !== undefined)
		throw new ConfigError(
			"config ops: name an agent or a conversation, not both. Keep the one the reports go to.",
		);
	if (agent !== undefined) {
		if (!withDiscord)
			throw new ConfigError(
				'config ops.agent: the agents live in Discord, which is not configured. Report to a conversation a plugin\'s chat surface serves instead, with ops: { conversation: "<surface>:<id>" }; the web chat takes no error reports.',
			);
		return { agent };
	}
	if (conversation === undefined)
		throw new ConfigError(
			'config ops: name an agent or a conversation, such as ops: { agent: "infra" } or ops: { conversation: "<surface>:<id>" }.',
		);
	if (!/^[^:]+:.+$/.test(conversation))
		throw new ConfigError(
			`config ops.conversation: expected a conversation key <surface>:<id>, got ${JSON.stringify(conversation)}. Write the surface's prefix, a colon, and the conversation's id.`,
		);
	return { conversation: conversation as ChannelKey };
}

/** Refuses what only the agent server serves on a host without Discord, naming the key. */
function refuseAgentServerKeys(config: RoundtableConfig): void {
	if (config.agents && config.agents.length > 0)
		throw new ConfigError(
			"config agents: the agents live in Discord, which is not configured. Configure discord, or remove agents.",
		);
	if (config.skills)
		throw new ConfigError(
			"config skills: the skills are the agents', and the agents live in Discord, which is not configured. Configure discord, or remove skills.",
		);
}

/** The configuration checked against its schema, defaults filled; throws a ConfigError naming the key and the fix. */
export function resolveConfig(input: unknown): ResolvedConfig {
	const config = schema.check(liftAdapters(input), "") as RoundtableConfig;
	const name = config.name ?? "Roundtable";
	const model = modelOf(config.model, "model");
	const thinking = config.thinking ?? "medium";
	const { discord, http } = config;
	if (discord && !http?.publicUrl)
		throw new ConfigError(
			"config http.publicUrl: required with discord, expected the public address that reaches the bot; Discord fetches the agents' avatars from it. Add it to roundtable.config.ts.",
		);
	if (!discord) refuseAgentServerKeys(config);
	const slug =
		discord?.rootCommand ?? name.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
	const ops = opsOf(config.ops, discord !== undefined);
	const access = accessOf(config, discord !== undefined);
	const { primaryOwner } = access;
	return {
		name,
		slug,
		...access,
		owner: {
			id: primaryOwner.id,
			name: primaryOwner.name,
			pronouns: primaryOwner.pronouns,
		},
		...(discord
			? {
					discord: {
						token: discord.token,
						guild: discord.guild,
						entryChannel: discord.entryChannel,
						rootCommand: slug,
						admin: discord.admin ?? true,
						...(discord.refusalHint === undefined
							? {}
							: { refusalHint: discord.refusalHint }),
						...(discord.agentMemory === undefined
							? {}
							: { agentMemory: discord.agentMemory }),
						channelContext: discord.channelContext ?? {},
						...(discord.freshMarker === undefined
							? {}
							: { freshMarker: discord.freshMarker }),
					},
				}
			: {}),
		databaseUrl: config.database.url,
		dataDir: config.dataDir,
		agentDir: config.agentDir ?? `${config.dataDir}/pi`,
		model,
		thinking,
		judge: {
			model: config.judge?.model
				? modelOf(config.judge.model, "judge.model")
				: model,
			threshold: config.judge?.threshold ?? 0.6,
		},
		delegation: {
			model: config.delegation?.model
				? modelOf(config.delegation.model, "delegation.model")
				: model,
			thinking: config.delegation?.thinking ?? "medium",
		},
		locale: config.locale ?? "en",
		timeZone: config.timeZone ?? "UTC",
		speakers: {
			...(config.speakers?.admins ? { admins: config.speakers.admins } : {}),
			...(config.speakers?.members ? { members: config.speakers.members } : {}),
		},
		background: { perPrincipal: { ...config.background?.perPrincipal } },
		toolTiers: config.toolTiers ?? {},
		prompts: config.prompts ?? {},
		agents: config.agents ?? [],
		...(http
			? {
					http: {
						...(http.publicUrl ? { publicUrl: http.publicUrl } : {}),
						port: http.port ?? 3000,
						...(http.hostname ? { hostname: http.hostname } : {}),
						...(http.socketPath ? { socketPath: http.socketPath } : {}),
						...(http.socketMode === undefined
							? {}
							: { socketMode: http.socketMode }),
					},
				}
			: {}),
		...(config.avatar ? { avatar: config.avatar } : {}),
		workDir: config.workDir ?? `${config.dataDir}/work`,
		scratchDir: config.scratchDir ?? join(tmpdir(), `${slug}-scratch`),
		// Without Discord there are no agents to carry skills, so the addon is off.
		skills: config.skills ?? (discord ? {} : false),
		memory: config.memory ?? true,
		...(ops ? { ops } : {}),
		interimText: config.interimText ?? "on",
		interimPrimaryChars: config.interimPrimaryChars ?? PRIMARY_CHARS,
		plugins: config.plugins ?? [],
	};
}
