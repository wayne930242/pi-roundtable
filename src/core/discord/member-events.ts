import { type Client, Events, GatewayIntentBits } from "discord.js";
import type { Logger } from "../kernel/log.ts";
import type { MemberJoinedEvent } from "../plugin-api/event-types.ts";

/** The privileged Server Members intent, asked for only when the host turns `discord.memberEvents` on. */
export function memberIntents(
	enabled: boolean | undefined,
): GatewayIntentBits[] {
	return enabled ? [GatewayIntentBits.GuildMembers] : [];
}

/** Reports each member that joins a server to `handler`; one that throws is logged and never stops the next. */
export function listenForJoins(
	client: Client,
	handler: (event: MemberJoinedEvent) => void,
	logger: Logger,
): void {
	client.on(Events.GuildMemberAdd, (member) => {
		try {
			handler({
				surface: "discord",
				guildId: member.guild.id,
				userId: member.id,
				bot: member.user.bot,
			});
		} catch (error) {
			logger.error({ err: error }, "member join handler failed");
		}
	});
}

/** The error a failed login throws, with the portal switch named when Discord refused the Server Members intent. */
export function explainIntents(
	error: unknown,
	enabled: boolean | undefined,
): Error {
	const failed = error instanceof Error ? error : new Error(String(error));
	if (enabled && /disallowed intents/i.test(failed.message))
		return new Error(
			"Discord refused the Server Members intent that discord.memberEvents asks for. Turn on Server Members Intent under Bot in https://discord.com/developers/applications, save, and start again, or set discord.memberEvents to false.",
			{ cause: failed },
		);
	return failed;
}
