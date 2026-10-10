import type { ChannelContextOptions } from "../contract/channel-context.ts";
import { ConfigError } from "../domain/errors.ts";
import {
	bool,
	integer,
	number,
	oneOf,
	optional,
	orOff,
	shape,
	text,
} from "./schema.ts";

/** The Discord bot and its guild, as the top-level `discord` or `discord()` from `pi-roundtable/discord` gives them. */
export interface DiscordConfig {
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
	/**
	 * Whose turns in the agents' channels load memory: `"everyone"` (default) lets each speaker
	 * read their own, `"owners"` only the owners, so a guest's turn has no memory in its prompt and
	 * no memory tools, and never makes claude-bridge refuse the owner afterwards.
	 */
	agentMemory?: "everyone" | "owners";
	/**
	 * What a turn addressed to the assistant in a server channel reads of the messages posted there
	 * since its last post, mentions or not; on with the defaults when left out. `false` turns it off
	 * for the agent server and every plugin's claim.
	 */
	channelContext?: ChannelContextOptions | false;
	/**
	 * The divider the assistant posts in a server channel or thread when its conversation starts
	 * over (a new conversation by an owner's command), which ends the window channel context reads;
	 * never in a direct message. Default `─── new conversation ───`; `false` posts none.
	 */
	freshMarker?: string | false;
	/**
	 * Seconds a turn waits on an owner card (an approval or an `ask_user` question) before it goes
	 * on without the answer; the card stays open, and answering it later starts a new turn with
	 * the answer. Default 120.
	 */
	cardGraceSeconds?: number;
}

/** The Discord settings with every default filled in. */
export interface ResolvedDiscord {
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
	cardGraceSeconds: number;
}

/** The configured Discord settings, defaults filled in; `rootCommand` is the host's slug. */
export function resolvedDiscord(
	discord: DiscordConfig,
	rootCommand: string,
): ResolvedDiscord {
	return {
		token: discord.token,
		guild: discord.guild,
		entryChannel: discord.entryChannel,
		rootCommand,
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
		cardGraceSeconds: discord.cardGraceSeconds ?? 120,
	};
}

/** What `discord.channelContext` takes besides `false`. */
const channelContextShape = shape({
	fetch: optional(integer(1, 100)),
	keep: optional(integer(1, 100)),
	similarity: optional(number(0, 1)),
	messageChars: optional(integer(1, 4000)),
	botMessageChars: optional(integer(1, 4000)),
});

/** The Discord settings, at the top level or in a Discord adapter. */
export const discordShape = shape({
	token: text,
	guild: text,
	entryChannel: text,
	rootCommand: optional(text),
	admin: optional(bool),
	refusalHint: optional(text),
	agentMemory: optional(oneOf<"everyone" | "owners">("everyone", "owners")),
	channelContext: optional(orOff(channelContextShape)),
	freshMarker: optional(orOff(text)),
	cardGraceSeconds: optional(integer(1, 86_400)),
});

/** The adapters `adapters` takes, by the name their factory gives them. */
const ADAPTERS = ["discord"] as const;

/**
 * The configuration with its adapters in the places the host reads them: a Discord adapter's
 * settings as the top-level `discord`. Throws a ConfigError naming the adapter by its place.
 */
// pi-lens-ignore: no-unknown-returns — the configuration as written is untyped until the schema checks it
export function liftAdapters(input: unknown): unknown {
	if (typeof input !== "object" || input === null || !("adapters" in input))
		return input;
	const { adapters, ...rest } = input as Record<string, unknown>;
	if (adapters === undefined) return rest;
	if (!Array.isArray(adapters))
		throw new ConfigError(
			`config adapters: expected a list of adapters, such as [discord({ ... })] with discord from pi-roundtable/discord, got ${JSON.stringify(adapters)}. Fix the value in roundtable.config.ts.`,
		);
	const lifted: Record<string, unknown> = { ...rest };
	adapters.forEach((entry: unknown, index) => {
		const at = `adapters[${index}]`;
		const name =
			typeof entry === "object" && entry !== null
				? (entry as { adapter?: unknown }).adapter
				: undefined;
		if (typeof name !== "string")
			throw new ConfigError(
				`config ${at}: expected an adapter, an object its factory makes such as discord({ ... }) from pi-roundtable/discord, got ${JSON.stringify(entry)}. Fix the value in roundtable.config.ts.`,
			);
		if (!(ADAPTERS as readonly string[]).includes(name))
			throw new ConfigError(
				`config ${at}: unknown adapter ${JSON.stringify(name)}. The adapters are ${ADAPTERS.join(", ")}; a chat network that comes as a plugin, such as pi-roundtable-webchat's webChat(), belongs in plugins.`,
			);
		if (lifted.discord !== undefined)
			throw new ConfigError(
				`config ${at}: Discord is configured twice, at the top level or by another adapter. Keep one.`,
			);
		const { adapter: _adapter, ...settings } = entry as Record<string, unknown>;
		lifted.discord = shape({ discord: discordShape }).check(
			settings,
			at,
		).discord;
	});
	return lifted;
}
