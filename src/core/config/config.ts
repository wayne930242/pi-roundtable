import { tmpdir } from "node:os";
import { join } from "node:path";
import { CATALOG, type Hex } from "../../characters/index.ts";
import type { AgentSeed } from "../agents/agent-rules.ts";
import { ConfigError } from "../domain/errors.ts";
import type { InterimTextMode } from "../domain/interim.ts";
import { DRAIN_LIMIT_MS } from "../drain.ts";
import type { Locale } from "../i18n/index.ts";
import type { AccessRules } from "../identity/access-policy.ts";
import type { ProfileRules } from "../identity/profiles.ts";
import type { OwnerIdentity } from "../identity.ts";
import {
	type EffortPolicy,
	type ModelRef,
	parseModelRef,
	type ThinkingLevel,
} from "../models.ts";
import type { PerPrincipalLimits } from "../modules/background/personal-target.ts";
import type { AgentTools, RoundtablePlugin } from "../plugin.ts";
import { PRIMARY_CHARS } from "../runtime/interim-text.ts";
import type { Tier, TierMembers } from "../speakers.ts";
import { type AccessConfig, accessOf } from "./access.ts";
import {
	type DiscordConfig,
	liftAdapters,
	type ResolvedDiscord,
	resolvedDiscord,
} from "./adapters.ts";
import { checkAgentServerOff, checkAgentTeamKeys } from "./agent-team.ts";
import type { AttachmentsConfig } from "./attachments.ts";
import { configSchema } from "./config-schema.ts";
import type { ConversationsConfig } from "./conversations.ts";
import { type LimitsConfig, limitsOf, type ResolvedLimits } from "./limits.ts";
import { opsOf, opsOfPlace, type ResolvedOps } from "./ops.ts";
import { type ProfilesConfig, profileRulesOf } from "./profiles.ts";
import {
	type ResolvedRouting,
	type RoutingConfig,
	routingOf,
} from "./routing.ts";
import type { SkillsConfig } from "./skills-config.ts";

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
export interface RoundtableConfig extends LimitsConfig {
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
	 * without Discord: no Discord plugins and no tool that messages the owner on Discord;
	 * conversations come through the plugins' own surfaces. The agent team (`agents`, `skills`) then
	 * lives in the rooms of a surface that hosts them, such as pi-roundtable-web, and the host
	 * refuses to start without one. The same settings may come as `adapters: [discord({...})]`
	 * instead, never both.
	 */
	discord?: DiscordConfig;
	/**
	 * `false` leaves the agent server out of a host that has `discord`: no agent team, no
	 * `#dashboard` channel or pinned message, no agent channels or routes, no coordinator, and no
	 * skills addon. Discord, access, memory, commands and the plugins' claims work as before;
	 * `discord.entryChannel` is optional and `http.publicUrl` is no longer required (it serves only
	 * the agents' avatars). Refused together with anything only agents use: `agents`, `skills`,
	 * `ops.agent`, `discord.agentMemory`, `discord.agentSpeakers`, `discord.attachmentDownload`.
	 * Plugins that need the agent server (pi-roundtable-web, remote-mcp's default conversation)
	 * stop startup. Left out, the agent server runs; there is no `true`.
	 *
	 * `{ tools: "chat-only" }` keeps the agent server and takes the machine away from its agents:
	 * no shell, file or workspace tools in any turn, and no plugin whose tools reach the host
	 * (`hostAccess`, such as pi-roundtable-coding). The agents talk, remember, schedule and use the
	 * tools plugins add for them. Left out, the agents carry the shell and file tools.
	 */
	agentServer?: false | { tools: "chat-only" };
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
	/** What the host does with the files people send, such as removing them after a retention period. */
	attachments?: AttachmentsConfig;
	/** What the host does with the conversations it has recorded, such as deleting idle ones of a kind. */
	conversations?: ConversationsConfig;
	/** Pi's agent directory, holding the model logins; default `<dataDir>/pi`. */
	agentDir?: string;
	/** The model of the agents, written `<provider>/<id>`. */
	model: string;
	/** The level a turn thinks at when its judge cannot pick; default "medium". */
	thinking?: ThinkingLevel;
	/** The model that judges small questions and the delegated tasks' model; default the agents' model. */
	judge?: { model?: string; threshold?: number };
	/** How each turn that thinks at the judge's choice is decided, instead of the default; see `EffortPolicy`. */
	effortPolicy?: EffortPolicy;
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
	 * How people are named: `prefer` lists the providers that name a person who has not chosen, the
	 * first they have linked winning, and `modelVisible` the providers whose names agents may read as
	 * `Speaker.name`. Default none of either, which leaves every name as it was.
	 */
	profiles?: ProfilesConfig;
	/**
	 * Each person's limits across all their conversations: `perPrincipal.schedules` they may keep and
	 * `perPrincipal.delegations` running at once. Unset, only each conversation's, as in 0.8.
	 */
	background?: BackgroundConfig;
	toolTiers?: Record<string, Tier>;
	/** Prompt files, read once at start; `shared` starts every agent's prompt. */
	prompts?: { shared: string; guest?: string };
	/**
	 * The first team, created once; an agent already stored is never overwritten. Without `discord`
	 * the team lives in the rooms of a surface that hosts them, so a seed has no `channelId`.
	 */
	agents?: AgentSeed[];
	/**
	 * Without `discord`, the name of the agent that coordinates the team: the one the owner's
	 * general requests come to, which cannot be archived. It must be one of `agents`; default the
	 * first. With `discord` the agent in `discord.entryChannel` is the coordinator, and this key is refused.
	 */
	coordinator?: string;
	/**
	 * How the agents' characters are drawn, everywhere the host draws them: the web console, its
	 * round table and the agents' pictures on Discord. `skins` is exactly six `#rrggbb` skin tones
	 * that a look's `skin` index (0 to 5) picks from, such as `EAST_ASIAN_SKINS` from
	 * `pi-roundtable/characters`; default the six the package ships. Stored looks keep their index,
	 * so they take the new tones with no migration. A bad list stops the start.
	 *
	 * `refreshAvatars` (default false) renders every agent's Discord picture again each time the
	 * agent server starts, with the host's skins, and sets it where it differs from the stored one,
	 * so an agent that was not saved since a redraw or a `skins` change catches up. It overwrites
	 * an agent that still wears an old hand-drawn (deprecated) picture. It runs after the start
	 * without holding it back; a restart with nothing changed sets nothing.
	 */
	characters?: { skins?: readonly string[]; refreshAvatars?: boolean };
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
	/** @deprecated Agents are composed characters since 0.23, so this picture is ignored and a warning is logged at start; removed in 1.0. */
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
	 * in their tables. Without `discord` and `agents` there is no one to carry skills, so the addon is off.
	 */
	skills?: false | SkillsConfig;
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
	 * @deprecated An alias of `routing.places.ops` since 0.27, which also accepts an agent whose
	 * primary place is not Discord; removed in 1.0. Setting both stops the start.
	 */
	ops?: { agent: string } | { conversation: string };
	/**
	 * Where events no person waits on land: the agents' primary places, where a webhook's report,
	 * a `message_agent` call and an opening task go, and the named places such as `ops`. Left out,
	 * every one lands where it did before the key existed.
	 */
	routing?: RoutingConfig;
	/**
	 * Seconds a shutdown waits for running turns before stopping them; default 180. Give the
	 * service manager a stop timeout a minute longer, such as systemd's `TimeoutStopSec`.
	 */
	drainSeconds?: number;
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

/** Logged once when the top-level `ops` is set: it is an alias of the `ops` place. */
export const OPS_DEPRECATION =
	"`ops` is an alias of `routing.places.ops` since 0.27 and goes away in 1.0; move it there";

/** Logged once when `avatar` is set: agents are composed characters and no picture is drawn from it. */
export const AVATAR_DEPRECATION =
	"agents are composed characters since 0.23; `avatar` is ignored";

/** The configuration with every default filled in. */
export interface ResolvedConfig extends ResolvedLimits {
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
	/** How people are named, checked; empty lists by default. */
	profiles: ProfileRules;
	/** What the configuration wrote in a deprecated form, which the host logs once. */
	deprecations: string[];
	/** Undefined on a host without Discord. */
	discord?: ResolvedDiscord;
	/** Whether the agent server runs: false when `agentServer: false`, and otherwise on a host with `discord` or `agents`. */
	agentServer: boolean;
	/** What the agents' turns may use of the machine: "chat-only" for `agentServer: { tools: "chat-only" }`, else "full". */
	agentTools: AgentTools;
	databaseUrl: string;
	dataDir: string;
	/** Absent `retention`: used files live as long as their conversation. */
	attachments: AttachmentsConfig;
	/** Days to keep each conversation kind after its last activity; a kind not listed is kept. */
	conversations: {
		keepDays: Readonly<Record<string, number>>;
		keep?: ConversationsConfig["keep"];
	};
	agentDir: string;
	model: ModelRef;
	thinking: ThinkingLevel;
	judge: { model: ModelRef; threshold: number };
	effortPolicy?: EffortPolicy;
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
	/** The coordinator's name; set only without `discord` and with `agents`: the configured one, else the first seed. */
	coordinator?: string;
	/** How the agents' characters are drawn: the six skin tones, the package's own unless `characters.skins` is set. */
	characters: { skins: readonly Hex[]; refreshAvatars: boolean };
	/** Undefined when no `http` is configured, and the host opens no `public` listener. */
	http?: {
		/** Always set with Discord, unless `agentServer` is false. */
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
	skills: false | SkillsConfig;
	memory: boolean;
	ops?: ResolvedOps;
	/** The config key `ops` came from, as error messages name it. */
	opsKey: "ops" | "routing.places.ops";
	/** The checked `routing` block; undefined when the configuration has none. */
	routing?: ResolvedRouting;
	drainMs: number;
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

/** The skin tones the configuration chose, or the package's own. */
function skinsOf(skins: readonly string[] | undefined): readonly Hex[] {
	return (skins as readonly Hex[] | undefined) ?? CATALOG.skins;
}

/** The configuration checked against its schema, defaults filled; throws a ConfigError naming the key and the fix. */
export function resolveConfig(input: unknown): ResolvedConfig {
	const config = configSchema.check(
		liftAdapters(input),
		"",
	) as RoundtableConfig;
	const name = config.name ?? "Roundtable";
	const model = modelOf(config.model, "model");
	const thinking = config.thinking ?? "medium";
	const { discord, http } = config;
	const agentServer = config.agentServer !== false;
	if (!agentServer) checkAgentServerOff(config);
	if (discord && agentServer && !discord.entryChannel)
		throw new ConfigError(
			"config discord.entryChannel: required, expected the id of the channel the coordinator lives in. Add it to roundtable.config.ts, or set agentServer: false for a host without agents.",
		);
	if (discord && agentServer && !http?.publicUrl)
		throw new ConfigError(
			"config http.publicUrl: required with discord, expected the public address that reaches the bot; Discord fetches the agents' avatars from it. Add it to roundtable.config.ts.",
		);
	checkAgentTeamKeys(config, discord !== undefined);
	const slug =
		discord?.rootCommand ?? name.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
	const routing = routingOf(config.routing, {
		withDiscord: discord !== undefined,
		agentServer:
			agentServer &&
			(discord !== undefined || (config.agents?.length ?? 0) > 0),
		topLevelOps: config.ops !== undefined,
	});
	const ops =
		opsOf(config.ops, discord !== undefined) ?? opsOfPlace(routing?.places.ops);
	const access = accessOf(config, discord !== undefined);
	const { primaryOwner } = access;
	return {
		name,
		slug,
		...access,
		profiles: profileRulesOf(config.profiles),
		deprecations: [
			...access.deprecations,
			...(config.avatar ? [AVATAR_DEPRECATION] : []),
			...(config.ops ? [OPS_DEPRECATION] : []),
		],
		owner: {
			id: primaryOwner.id,
			name: primaryOwner.name,
			pronouns: primaryOwner.pronouns,
		},
		...(discord ? { discord: resolvedDiscord(discord, slug) } : {}),
		databaseUrl: config.database.url,
		dataDir: config.dataDir,
		attachments: config.attachments?.retention
			? { retention: config.attachments.retention }
			: {},
		conversations: {
			keepDays: { ...config.conversations?.keepDays },
			...(config.conversations?.keep
				? { keep: config.conversations.keep }
				: {}),
		},
		agentDir: config.agentDir ?? `${config.dataDir}/pi`,
		model,
		thinking,
		judge: {
			model: config.judge?.model
				? modelOf(config.judge.model, "judge.model")
				: model,
			threshold: config.judge?.threshold ?? 0.6,
		},
		...(config.effortPolicy ? { effortPolicy: config.effortPolicy } : {}),
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
		agentServer:
			agentServer &&
			(discord !== undefined || (config.agents?.length ?? 0) > 0),
		agentTools:
			typeof config.agentServer === "object"
				? config.agentServer.tools
				: "full",
		...(!discord && config.agents?.[0]
			? { coordinator: config.coordinator ?? config.agents[0].name }
			: {}),
		characters: {
			skins: skinsOf(config.characters?.skins),
			refreshAvatars: config.characters?.refreshAvatars ?? false,
		},
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
		// Without Discord and without agents there is no one to carry skills, so the addon is off.
		skills: agentServer
			? (config.skills ?? (discord || config.agents?.length ? {} : false))
			: false,
		memory: config.memory ?? true,
		...(ops ? { ops } : {}),
		opsKey: config.ops ? "ops" : "routing.places.ops",
		...(routing ? { routing } : {}),
		drainMs: (config.drainSeconds ?? DRAIN_LIMIT_MS / 1_000) * 1_000,
		...limitsOf(config),
		interimText: config.interimText ?? "on",
		interimPrimaryChars: config.interimPrimaryChars ?? PRIMARY_CHARS,
		plugins: config.plugins ?? [],
	};
}
