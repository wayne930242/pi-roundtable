import {
	type ChannelKey,
	type DirectChannelProvider,
	type IdentityService,
	PluginError,
} from "pi-roundtable";
import type { PushService } from "./triggers.ts";

export interface WebPushChannelOptions {
	/** The key prefix of the app's rooms, which names the provider. */
	surface: string;
	identity: Pick<IdentityService, "tierOf">;
	/** The room a notice to a person lands in: the home room; undefined when the team has none. */
	home(): ChannelKey | undefined;
	/** Writes a line the person will find in the room. */
	post(room: ChannelKey, text: string): Promise<void>;
	push: Pick<PushService, "notice">;
}

/**
 * The owner app as a way to reach an owner. A notice to them is written as a line in the home
 * room and pushed to their devices; one that another channel (such as a Discord direct message)
 * delivered is only pushed, so the phone hears it too.
 */
export function webPushChannel(
	options: WebPushChannelOptions,
): DirectChannelProvider {
	const { identity, home, post, push } = options;
	const isOwner = async (principalId: string) =>
		(await identity.tierOf(principalId)) === "owner";
	return {
		name: `web:${options.surface}`,
		surface: options.surface,
		label: "a notice in the web app",
		knows: async (principalId) =>
			(await isOwner(principalId)) && home() !== undefined,
		reaches: async (principalId) =>
			(await isOwner(principalId)) ? home() : undefined,
		deliver: async (principalId, text) => {
			const room = home();
			if (!room || !(await isOwner(principalId)))
				throw new PluginError("the web app has no room to post this notice in");
			await post(room, text);
			await push.notice(principalId, text, room);
		},
		mirror: async (principalId, text) => {
			const room = home();
			await push.notice(principalId, text, room);
		},
	};
}
