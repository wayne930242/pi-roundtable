import type { RoundtablePlugin } from "pi-roundtable";
import type { ResolvedOptions } from "../options.ts";
import type { createAuthenticator } from "./authenticator.ts";
import { discoverProvider, OidcLogin } from "./oidc.ts";
import { loadSessionKey } from "./session-key.ts";
import type { WebSessions } from "./sessions.ts";

type Context = Parameters<RoundtablePlugin["setup"]>[0];

export interface OidcParts {
	sessions: WebSessions;
	settings: ResolvedOptions;
	identify: Parameters<typeof createAuthenticator>[0]["identify"];
	logger: Context["logger"];
	events: Context["events"];
	ended(id: string): void;
}

/** Reads the provider's discovery document, the client secret and the session key, and makes the sign-in flow. */
export async function startOidc(
	auth: Extract<ResolvedOptions["auth"], { mode: "oidc" }>,
	parts: OidcParts,
): Promise<OidcLogin> {
	const { settings, logger } = parts;
	let clientSecret: string | undefined;
	if (auth.clientSecretEnv) {
		clientSecret = process.env[auth.clientSecretEnv];
		if (!clientSecret)
			throw new Error(
				`web-console: auth.clientSecretEnv names ${auth.clientSecretEnv}, which is not set`,
			);
	}
	return new OidcLogin({
		settings: auth,
		metadata: await discoverProvider(auth),
		...(clientSecret ? { clientSecret } : {}),
		sessions: parts.sessions,
		key: loadSessionKey(settings.dataDir, logger),
		origin: settings.origin,
		mount: settings.mount,
		surface: settings.surface,
		routing: settings.routing,
		title: settings.title,
		presentation: settings.presentation,
		identify: parts.identify,
		onSignIn: (info) =>
			parts.events.action?.({
				kind: "sign-in",
				actor: info.speakerId,
				principalId: info.principalId,
				ok: true,
				at: new Date(),
			}),
		onEnded: parts.ended,
		...(auth.onSessionVerified
			? { onSessionVerified: auth.onSessionVerified }
			: {}),
		logger,
	});
}
