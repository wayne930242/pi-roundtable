import { PluginError } from "pi-roundtable";
import type { ResolvedOidc } from "../options.ts";
import { PROVIDER_TIMEOUT_MS } from "./oidc-support.ts";

/** The provider's endpoints, from its discovery document. */
export interface ProviderMetadata {
	authorizationEndpoint: string;
	tokenEndpoint: string;
	jwksUri: string;
	/** Where logout can also sign out at the provider; absent when it offers none. */
	endSessionEndpoint?: string;
}

/** A URL the provider's discovery document named, already checked; throws if it somehow is none. */
export function urlOf(value: string): URL {
	const url = URL.parse(value);
	if (!url)
		throw new PluginError("pi-roundtable-web: an oidc endpoint is no URL");
	return url;
}

const endpoint = (value: unknown): string | undefined => {
	const url = typeof value === "string" ? URL.parse(value) : null;
	if (!url) return undefined;
	const loopback =
		url.protocol === "http:" &&
		["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
	return url.protocol === "https:" || loopback ? url.href : undefined;
};

/**
 * Reads the provider's discovery document and checks it names this issuer. Throws a PluginError
 * naming what is wrong, so a host with a wrong issuer or an unreachable provider stops at start.
 */
export async function discoverProvider(
	settings: Pick<ResolvedOidc, "issuer" | "discoveryUrl">,
	fetcher: typeof fetch = fetch,
): Promise<ProviderMetadata> {
	const fail = (what: string): never => {
		throw new PluginError(
			`pi-roundtable-web: the oidc discovery document at ${settings.discoveryUrl} ${what}`,
		);
	};
	let body: Record<string, unknown>;
	try {
		const response = await fetcher(settings.discoveryUrl, {
			signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
		});
		if (!response.ok) return fail(`answered ${response.status}`);
		body = (await response.json()) as Record<string, unknown>;
	} catch (error) {
		if (error instanceof PluginError) throw error;
		return fail("could not be read");
	}
	if (body.issuer !== settings.issuer)
		fail(
			`names the issuer ${JSON.stringify(body.issuer)}, not ${JSON.stringify(settings.issuer)}`,
		);
	const authorizationEndpoint = endpoint(body.authorization_endpoint);
	const tokenEndpoint = endpoint(body.token_endpoint);
	const jwksUri = endpoint(body.jwks_uri);
	if (!authorizationEndpoint || !tokenEndpoint || !jwksUri)
		fail("lacks an https authorization_endpoint, token_endpoint or jwks_uri");
	const end = endpoint(body.end_session_endpoint);
	return {
		authorizationEndpoint: authorizationEndpoint as string,
		tokenEndpoint: tokenEndpoint as string,
		jwksUri: jwksUri as string,
		...(end ? { endSessionEndpoint: end } : {}),
	};
}
