import type { ChannelKey } from "../domain/conversation.ts";
import type { IdentityService } from "../identity/identity-service.ts";
import type { DirectChannelProvider } from "../presence/direct-channels.ts";

export interface DiscordDirectChannelOptions {
	/** A Discord user's direct-message channel; throws when Discord cannot be reached. */
	directChannel(userId: string): Promise<ChannelKey>;
	/** Sends a Discord user a direct message. */
	sendDirect(userId: string, text: string): Promise<void>;
	/**
	 * Whom a principal is on Discord, by the Discord identities linked to them. Without it only the
	 * primary owner is reached, whose principal 0.8 knew by their Discord user id.
	 */
	identity?: Pick<IdentityService, "identities">;
	/**
	 * The primary owner's Discord user id: of a principal's Discord identities, the one reached
	 * first, so a single owner is reached in the direct messages 0.8 used.
	 */
	ownerId: string;
}

/**
 * Reaches a person in their Discord direct messages, through a Discord identity linked to their
 * principal; a principal with none is not reached here.
 */
export function discordDirectChannel(
	options: DiscordDirectChannelOptions,
): DirectChannelProvider {
	const { identity, ownerId } = options;
	const userOf = async (principalId: string): Promise<string | undefined> => {
		if (!identity) return principalId === ownerId ? ownerId : undefined;
		const users = (await identity.identities(principalId))
			.filter((link) => link.provider === "discord")
			.map((link) => link.subject);
		return users.includes(ownerId) ? ownerId : users[0];
	};
	return {
		name: "discord",
		label: "a direct message on Discord",
		reaches: async (principalId) => {
			const user = await userOf(principalId);
			return user === undefined ? undefined : options.directChannel(user);
		},
		deliver: async (principalId, text) => {
			const user = await userOf(principalId);
			if (user === undefined)
				throw new Error(
					`principal ${principalId} has no Discord identity to send a direct message to`,
				);
			await options.sendDirect(user, text);
		},
	};
}
