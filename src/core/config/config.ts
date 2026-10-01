import type { AgentSeed } from "../agents/agent-rules.ts";
import { ConfigError } from "../domain/errors.ts";
import { isLocale, type Locale } from "../i18n/index.ts";
import type { OwnerIdentity } from "../identity.ts";
import {
	type ModelRef,
	parseModelRef,
	THINKING_LEVELS,
	type ThinkingLevel,
} from "../models.ts";
import type { RoundtablePlugin } from "../plugin.ts";
import type { Tier, TierMembers } from "../speakers.ts";
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

/** How prompts refer back to the owner. */
export type Pronouns = "he" | "she" | "they";

/** Who holds a tier besides the owner: user ids, role ids, and for members everyone. */
export interface TierConfig {
	users?: readonly string[];
	roles?: readonly string[];
	everyone?: boolean;
}

/** What `roundtable.config.ts` gives `defineRoundtable`. */
export interface RoundtableConfig {
	/** The assistant's display name; default "Roundtable". */
	name?: string;
	/** The one owner: the only person who can change everything. */
	owner: { id: string; name: string; pronouns?: Pronouns };
	discord: {
		/** The bot token; keep it in `.env`, not in this file. */
		token: string;
		/** The agent server's guild id. */
		guild: string;
		/** The channel the coordinator lives in. */
		entryChannel: string;
		/** The root slash command, without the slash; default the lowercase assistant name. */
		rootCommand?: string;
		/**
		 * Whether the owner's conversations have Discord administration tools; default true. `false`
		 * leaves the `discord-admin` addon out.
		 */
		admin?: boolean;
		/**
		 * Text appended as it is to the refusal a non-owner gets from the root command, such as a
		 * pointer to the commands anyone may use; include the space or punctuation your language
		 * needs before it. Default none.
		 */
		refusalHint?: string;
	};
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
	/** Who may talk to the agents besides the owner, and what each tier may use. */
	speakers?: { admins?: TierConfig; members?: TierConfig };
	toolTiers?: Record<string, Tier>;
	/** Prompt files, read once at start; `shared` starts every agent's prompt. */
	prompts?: { shared: string; guest?: string };
	/** The first team, created once; an agent already stored is never overwritten. */
	agents?: AgentSeed[];
	/**
	 * Where the agents' avatars are served: the public address that reaches it, and the TCP port
	 * (default 3000) or unix socket the process listens on. `socketMode` is the socket file's
	 * permission bits (default `0o660`); widen it only for a proxy that runs as another user.
	 */
	http: {
		publicUrl: string;
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
	 * Where the skill registry reads built-in skills and keeps linked repositories. `false` leaves
	 * the `skills` addon out: agents carry no skills, and no skill tools exist. Stored skills stay
	 * in their tables.
	 */
	skills?: false | { builtinDir?: string; reposDir?: string };
	/**
	 * Whether each speaker's memory is kept and offered as tools; default true. `false` leaves the
	 * `memory` addon out: no memory tools, no memory prompt block, and the table stays as it is.
	 */
	memory?: boolean;
	/** The agent that investigates the process's own errors, by name. */
	ops?: { agent: string };
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
	owner: shape({
		id: text,
		name: text,
		pronouns: optional(oneOf<Pronouns>("he", "she", "they")),
	}),
	discord: shape({
		token: text,
		guild: text,
		entryChannel: text,
		rootCommand: optional(text),
		admin: optional(bool),
		refusalHint: optional(text),
	}),
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
	http: shape({
		publicUrl: text,
		port: optional(integer(1, 65535)),
		hostname: optional(text),
		socketPath: optional(text),
		socketMode: optional(integer(0, 0o777)),
	}),
	avatar: optional(text),
	workDir: optional(text),
	skills: optional(
		orOff(shape({ builtinDir: optional(text), reposDir: optional(text) })),
	),
	memory: optional(bool),
	ops: optional(shape({ agent: text })),
	plugins: optional(
		list(
			guarded("a plugin, an object with a name and a setup function", isPlugin),
		),
	),
});

const PRONOUNS: Record<Pronouns, OwnerIdentity["pronouns"]> = {
	he: { subject: "he", object: "him", possessive: "his" },
	she: { subject: "she", object: "her", possessive: "her" },
	they: { subject: "they", object: "them", possessive: "their" },
};

/** The configuration with every default filled in. */
export interface ResolvedConfig {
	name: string;
	owner: OwnerIdentity & { id: string };
	discord: {
		token: string;
		guild: string;
		entryChannel: string;
		rootCommand: string;
		admin: boolean;
		refusalHint?: string;
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
	speakers: { admins?: TierMembers; members?: TierMembers };
	toolTiers: Record<string, Tier>;
	prompts: { shared?: string; guest?: string };
	agents: AgentSeed[];
	http: {
		publicUrl: string;
		port: number;
		hostname?: string;
		socketPath?: string;
		socketMode?: number;
	};
	avatar?: string;
	workDir: string;
	/** `false` when the skills addon is off. */
	skills: false | { builtinDir?: string; reposDir?: string };
	memory: boolean;
	ops?: { agent: string };
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

/** The configuration checked against its schema, defaults filled; throws a ConfigError naming the key and the fix. */
export function resolveConfig(input: unknown): ResolvedConfig {
	const config = schema.check(input, "") as RoundtableConfig;
	const name = config.name ?? "Roundtable";
	const model = modelOf(config.model, "model");
	const thinking = config.thinking ?? "medium";
	return {
		name,
		owner: {
			id: config.owner.id,
			name: config.owner.name,
			pronouns: PRONOUNS[config.owner.pronouns ?? "they"],
		},
		discord: {
			token: config.discord.token,
			guild: config.discord.guild,
			entryChannel: config.discord.entryChannel,
			rootCommand:
				config.discord.rootCommand ??
				name.toLowerCase().replace(/[^a-z0-9-]+/g, "-"),
			admin: config.discord.admin ?? true,
			...(config.discord.refusalHint === undefined
				? {}
				: { refusalHint: config.discord.refusalHint }),
		},
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
		toolTiers: config.toolTiers ?? {},
		prompts: config.prompts ?? {},
		agents: config.agents ?? [],
		http: {
			publicUrl: config.http.publicUrl,
			port: config.http.port ?? 3000,
			...(config.http.hostname ? { hostname: config.http.hostname } : {}),
			...(config.http.socketPath ? { socketPath: config.http.socketPath } : {}),
			...(config.http.socketMode === undefined
				? {}
				: { socketMode: config.http.socketMode }),
		},
		...(config.avatar ? { avatar: config.avatar } : {}),
		workDir: config.workDir ?? `${config.dataDir}/work`,
		skills: config.skills ?? {},
		memory: config.memory ?? true,
		...(config.ops ? { ops: config.ops } : {}),
		plugins: config.plugins ?? [],
	};
}
