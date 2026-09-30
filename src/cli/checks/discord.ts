import {
	channelPermissions,
	DiscordApi,
	inviteUrl,
	REQUIRED_PERMISSIONS,
} from "../discord-api.ts";
import type { Http, HttpResponse } from "../http.ts";
import type { Project } from "../project.ts";
import { fail, ok, type Result, skipped } from "../report.ts";

const PORTAL = "https://discord.com/developers/applications";
const MESSAGE_CONTENT_FLAGS = (1 << 18) | (1 << 19);

const object = (value: unknown): Record<string, unknown> =>
	typeof value === "object" && value !== null
		? (value as Record<string, unknown>)
		: {};

type Bot = { id: string; name: string };
type Step<T> = { ok: true; value: T } | { ok: false; result: Result };

/**
 * The bot's own view of Discord, asked at most once per fact, so four checks cost four
 * requests, not ten. A failed step says why once and the checks after it are skipped.
 */
export class Discord {
	readonly #project: Project;
	readonly #http: Http;
	#api: Promise<Step<DiscordApi>> | undefined;
	#bot: Promise<Step<Bot>> | undefined;

	constructor(project: Project, http: Http) {
		this.#project = project;
		this.#http = http;
	}

	async #client(): Promise<Step<DiscordApi>> {
		const token = await this.#project.text("discord", "token");
		return token
			? { ok: true, value: new DiscordApi(this.#http, token) }
			: { ok: false, result: skipped("discord.token has no value") };
	}

	/** One request; a network failure becomes a failed result naming the address. */
	async ask(api: DiscordApi, path: string): Promise<Step<HttpResponse>> {
		try {
			return { ok: true, value: await api.get(path) };
		} catch (error) {
			return {
				ok: false,
				result: fail(
					`cannot reach discord.com: ${error instanceof Error ? error.message : String(error)}`,
					"Check the network connection and try again.",
				),
			};
		}
	}

	api(): Promise<Step<DiscordApi>> {
		this.#api ??= this.#client();
		return this.#api;
	}

	/** Who the token belongs to. */
	bot(): Promise<Step<Bot>> {
		this.#bot ??= this.#identify();
		return this.#bot;
	}

	async #identify(): Promise<Step<Bot>> {
		const api = await this.api();
		if (!api.ok) return api;
		const answer = await this.ask(api.value, "/users/@me");
		if (!answer.ok) return answer;
		const { status, body } = answer.value;
		if (status === 401)
			return {
				ok: false,
				result: fail(
					"Discord rejected the bot token.",
					`Reset it under Bot in ${PORTAL} and put the new one in .env as DISCORD_TOKEN.`,
				),
			};
		const id = object(body).id;
		if (status !== 200 || typeof id !== "string")
			return {
				ok: false,
				result: fail(
					`Discord answered ${status} when asked who the token belongs to.`,
					"Try again in a moment; if it persists, check https://discordstatus.com.",
				),
			};
		return {
			ok: true,
			value: { id, name: String(object(body).username ?? id) },
		};
	}
}

/** The token is one Discord accepts. */
export async function checkToken(discord: Discord): Promise<Result> {
	const bot = await discord.bot();
	return bot.ok ? ok(`the bot is ${bot.value.name}`) : bot.result;
}

/** The bot is a member of the configured guild; the fix is an invitation that asks for what it needs. */
export async function checkGuild(
	project: Project,
	discord: Discord,
): Promise<Result> {
	const guild = await project.text("discord", "guild");
	if (!guild) return skipped("discord.guild has no value");
	const bot = await discord.bot();
	if (!bot.ok) return skipped("the token check failed");
	const api = await discord.api();
	if (!api.ok) return api.result;
	const answer = await discord.ask(api.value, `/guilds/${guild}`);
	if (!answer.ok) return answer.result;
	const { status, body } = answer.value;
	if (status === 200) return ok(`the bot is in ${String(object(body).name)}`);
	if (status === 403 || status === 404)
		return fail(
			`the bot is not in the guild ${guild}, or the guild id is wrong.`,
			`Check DISCORD_GUILD_ID, then invite the bot: ${inviteUrl(bot.value.id)}`,
		);
	return fail(
		`Discord answered ${status} when asked for the guild ${guild}.`,
		"Try again in a moment.",
	);
}

/** The Message Content intent is switched on, without which the agents cannot read the channels. */
export async function checkIntents(discord: Discord): Promise<Result> {
	const bot = await discord.bot();
	if (!bot.ok) return skipped("the token check failed");
	const api = await discord.api();
	if (!api.ok) return api.result;
	const answer = await discord.ask(api.value, "/applications/@me");
	if (!answer.ok) return answer.result;
	const flags = object(answer.value.body).flags;
	if (answer.value.status !== 200 || typeof flags !== "number")
		return fail(
			`Discord answered ${answer.value.status} when asked for the application.`,
			"Try again in a moment.",
		);
	if ((flags & MESSAGE_CONTENT_FLAGS) === 0)
		return fail(
			"the Message Content intent is off.",
			`Turn on Message Content Intent under Bot in ${PORTAL}, save, and run the check again.`,
		);
	return ok("the Message Content intent is on");
}

/** The entry channel exists in the guild and the bot may do in it what the agents do. */
export async function checkChannel(
	project: Project,
	discord: Discord,
): Promise<Result> {
	const channel = await project.text("discord", "entryChannel");
	const guild = await project.text("discord", "guild");
	if (!channel || !guild)
		return skipped("discord.entryChannel or discord.guild has no value");
	const bot = await discord.bot();
	if (!bot.ok) return skipped("the token check failed");
	const api = await discord.api();
	if (!api.ok) return api.result;
	const found = await discord.ask(api.value, `/channels/${channel}`);
	if (!found.ok) return found.result;
	const shown = object(found.value.body);
	if (found.value.status === 403 || found.value.status === 404)
		return fail(
			`the bot cannot see a channel ${channel}.`,
			"Check DISCORD_ENTRY_CHANNEL_ID, and that the bot's role may view the channel.",
		);
	if (found.value.status !== 200)
		return fail(
			`Discord answered ${found.value.status} when asked for the channel ${channel}.`,
			"Try again in a moment.",
		);
	if (shown.guild_id !== guild)
		return fail(
			`the channel ${channel} belongs to another guild.`,
			"Use a channel of the configured guild for DISCORD_ENTRY_CHANNEL_ID.",
		);
	const [guildAnswer, member] = await Promise.all([
		discord.ask(api.value, `/guilds/${guild}`),
		discord.ask(api.value, `/guilds/${guild}/members/${bot.value.id}`),
	]);
	if (!guildAnswer.ok) return guildAnswer.result;
	if (!member.ok) return member.result;
	if (guildAnswer.value.status !== 200 || member.value.status !== 200)
		return fail(
			`Discord did not show the bot's roles (${guildAnswer.value.status}, ${member.value.status}).`,
			"Check that the bot is in the guild, then try again.",
		);
	const guildFacts = object(guildAnswer.value.body);
	const granted = channelPermissions({
		botId: bot.value.id,
		guildId: guild,
		ownerId: String(guildFacts.owner_id),
		roles: (guildFacts.roles as { id: string; permissions: string }[]) ?? [],
		memberRoles: (object(member.value.body).roles as string[]) ?? [],
		overwrites:
			(shown.permission_overwrites as {
				id: string;
				type: number;
				allow: string;
				deny: string;
			}[]) ?? [],
	});
	const lacking = REQUIRED_PERMISSIONS.filter(([name]) => !granted.has(name));
	if (lacking.length > 0)
		return fail(
			`in the entry channel the bot lacks ${lacking.map(([name]) => name).join(", ")}.`,
			`Grant them to the bot's role or in the channel's permissions (${lacking.map(([name, use]) => `${name} to ${use}`).join("; ")}).`,
		);
	return ok("the bot has every permission it needs there");
}
