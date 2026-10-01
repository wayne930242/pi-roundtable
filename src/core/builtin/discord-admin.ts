import type { OwnerIdentity } from "../identity.ts";
import {
	DISCORD_ADMIN_TOOLS,
	discordAdminExtension,
} from "../modules/discord-admin/discord-admin.ts";
import type { RoundtablePlugin } from "../plugin.ts";
import { DISCORD } from "./discord.ts";
import { fixed } from "./session-tool.ts";

export interface DiscordAdminOptions {
	/** Whose Discord permissions the tools check, and who they serve. */
	owner: OwnerIdentity & { id: string };
}

/**
 * Discord administration: the owner's tools to read and manage the server, each a session tool
 * of every conversation, built on the Discord connection. An addon; `discord.admin: false` leaves
 * it out, and no conversation has a Discord tool.
 */
export function discordAdminPlugin(
	options: DiscordAdminOptions,
): RoundtablePlugin {
	const { owner } = options;
	return {
		name: "discord-admin",
		setup: ({ services }) => {
			const { connection } = services.get(DISCORD);
			return {
				sessionTools: [
					fixed("discord-admin", () =>
						discordAdminExtension(connection.ownerOperations(), owner),
					),
				],
				// Administering the server stays with the owner until an operator lowers a tool.
				toolTiers: Object.fromEntries(
					DISCORD_ADMIN_TOOLS.map((tool) => [tool, "owner" as const]),
				),
			};
		},
	};
}
