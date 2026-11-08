import type { ResolvedOptions } from "./options.ts";
import type { WebAppRegistry } from "./web-app.ts";

/** What the host registered, checked when the service starts: every provider onboarding names has its prover. */
export function checkRegistered(
	settings: ResolvedOptions,
	webApp: WebAppRegistry,
) {
	if (
		settings.onboarding.push !== "off" &&
		(!settings.panes.includes("rooms") ||
			(settings.push.sender === "internal" && !settings.push.subject))
	)
		throw new Error(
			"web-console: onboarding.push asks people to turn push on, but push is off here. It needs the rooms pane and a push.subject (or an external sender)",
		);
	for (const provider of Object.keys(settings.onboarding.links))
		if (!webApp.prover(provider))
			throw new Error(
				`web-console: onboarding.links names ${provider}, but no plugin registered a link prover for it (WEB_APP.registerLinkProver)`,
			);
}
