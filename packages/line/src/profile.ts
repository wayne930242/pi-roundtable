import type { ProfileSource } from "pi-roundtable";
import type { LineApiPort } from "./api-port.ts";
import { sourceKeyOf } from "./events.ts";

/**
 * The names and pictures of the people who added the bot, for `PROFILES.register`: LINE's
 * `/v2/bot/profile/{userId}` through the plugin's own token and timeout. The picture hosts are
 * LINE's profile-picture CDNs. `modelVisible` is false: a host that lets agents read LINE names
 * lists `line` in `profiles.modelVisible` itself.
 *
 *     setup: ({ services }) => {
 *       services.get(PROFILES).register(lineProfileSource(services.get(LINE).api));
 *     }
 */
export function lineProfileSource(
	api: Pick<LineApiPort, "profile">,
): ProfileSource {
	return {
		provider: "line",
		label: "LINE",
		modelVisible: false,
		pictureHosts: ["profile.line-scdn.net", "obs.line-scdn.net"],
		async fetch(subject, signal) {
			const profile = await api.profile(sourceKeyOf("user", subject), subject, {
				signal,
			});
			return profile
				? {
						name: profile.displayName,
						...(profile.pictureUrl ? { pictureUrl: profile.pictureUrl } : {}),
					}
				: undefined;
		},
	};
}
