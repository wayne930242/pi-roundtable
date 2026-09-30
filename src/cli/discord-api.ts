import { PermissionFlagsBits, PermissionsBitField } from "discord.js";
import type { Http, HttpResponse } from "./http.ts";

const API = "https://discord.com/api/v10";

/** What the bot needs in the entry channel, and why; the doctor names any it lacks. */
export const REQUIRED_PERMISSIONS = [
	["ViewChannel", "see the channel"],
	["SendMessages", "answer in it"],
	["SendMessagesInThreads", "answer in threads"],
	["ReadMessageHistory", "read what was said before"],
	["EmbedLinks", "post cards"],
	["AttachFiles", "post pictures and files"],
	["PinMessages", "pin the dashboard"],
	["CreatePublicThreads", "open threads for background reports"],
	["ManageChannels", "create the agents' channels"],
	["ManageWebhooks", "let each agent speak under its own name"],
] as const satisfies readonly (readonly [
	keyof typeof PermissionFlagsBits,
	string,
])[];

/** The permission integer an invitation asks for. */
export const INVITE_PERMISSIONS = REQUIRED_PERMISSIONS.reduce(
	(bits, [name]) => bits | PermissionFlagsBits[name],
	0n,
);

export function inviteUrl(botId: string): string {
	return `https://discord.com/oauth2/authorize?client_id=${botId}&scope=bot+applications.commands&permissions=${INVITE_PERMISSIONS}`;
}

interface Role {
	id: string;
	permissions: string;
}

interface Overwrite {
	id: string;
	type: number;
	allow: string;
	deny: string;
}

/** What Discord grants `botId` in a channel: the guild's roles, then the channel's overwrites, as Discord documents. */
export function channelPermissions(input: {
	botId: string;
	guildId: string;
	ownerId: string;
	roles: readonly Role[];
	memberRoles: readonly string[];
	overwrites: readonly Overwrite[];
}): PermissionsBitField {
	if (input.botId === input.ownerId)
		return new PermissionsBitField(PermissionsBitField.All);
	let bits = 0n;
	for (const role of input.roles)
		if (role.id === input.guildId || input.memberRoles.includes(role.id))
			bits |= BigInt(role.permissions);
	if (bits & PermissionFlagsBits.Administrator)
		return new PermissionsBitField(PermissionsBitField.All);
	const apply = (allow: bigint, deny: bigint) => {
		bits = (bits & ~deny) | allow;
	};
	const pick = (match: (overwrite: Overwrite) => boolean) => {
		let allow = 0n;
		let deny = 0n;
		for (const overwrite of input.overwrites.filter(match)) {
			allow |= BigInt(overwrite.allow);
			deny |= BigInt(overwrite.deny);
		}
		apply(allow, deny);
	};
	pick((overwrite) => overwrite.id === input.guildId);
	pick(
		(overwrite) =>
			overwrite.type === 0 && input.memberRoles.includes(overwrite.id),
	);
	pick((overwrite) => overwrite.type === 1 && overwrite.id === input.botId);
	return new PermissionsBitField(bits);
}

/** The Discord REST calls the doctor makes with the bot's own token, over an injected client. */
export class DiscordApi {
	readonly #http: Http;
	readonly #headers: Record<string, string>;

	constructor(http: Http, token: string) {
		this.#http = http;
		this.#headers = { Authorization: `Bot ${token}` };
	}

	get(path: string): Promise<HttpResponse> {
		return this.#http.get(`${API}${path}`, this.#headers);
	}
}
