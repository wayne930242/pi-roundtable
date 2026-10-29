import { ConfigError } from "../domain/errors.ts";
import type { ProfileRules } from "../identity/profiles.ts";
import { list, optional, shape, text } from "./schema.ts";

/** The `profiles` key's shape. */
export const profilesShape = shape({
	prefer: optional(list(text)),
	modelVisible: optional(list(text)),
});

/** The `profiles` key as the configuration writes it. */
export interface ProfilesConfig {
	/** Providers that name a person who has not chosen, first linked one wins; default none. */
	prefer?: readonly string[];
	/**
	 * Providers whose names may become `Speaker.name`, the name agents read; default none. A source's
	 * own flag never decides this: only this list does.
	 */
	modelVisible?: readonly string[];
}

function providers(
	values: readonly string[] | undefined,
	key: string,
): string[] {
	const seen = new Set<string>();
	values?.forEach((provider, i) => {
		if (provider.trim() === "")
			throw new ConfigError(
				`config profiles.${key}[${i}]: expected a provider such as line, got ${JSON.stringify(provider)}.`,
			);
		if (provider === "oidc")
			throw new ConfigError(
				`config profiles.${key}[${i}]: an OIDC provider is written oidc:<base64url issuer>, not oidc; oidcProvider(issuer) from pi-roundtable/kit writes it.`,
			);
		if (seen.has(provider))
			throw new ConfigError(
				`config profiles.${key}[${i}]: ${provider} is listed twice.`,
			);
		seen.add(provider);
	});
	return [...seen];
}

/** The profile rules a `profiles` configuration means, checked. */
export function profileRulesOf(
	config: ProfilesConfig | undefined,
): ProfileRules {
	return {
		prefer: providers(config?.prefer, "prefer"),
		modelVisible: providers(config?.modelVisible, "modelVisible"),
	};
}
