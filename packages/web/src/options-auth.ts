import { fail } from "./options-common.ts";
import {
	DEFAULT_PASSWORD_ENV,
	DEFAULT_SESSION_DAYS,
	type OidcOptions,
	type ResolvedAuth,
	type ResolvedOidc,
	type WebConsoleOptions,
} from "./options-types.ts";
import type { RequestVerifier } from "./verifier.ts";

export function checkAuth(options: WebConsoleOptions): ResolvedAuth {
	const { auth, verifier } = options;
	if (auth !== undefined && verifier !== undefined)
		fail(
			'both auth and verifier are given. `verifier` is shorthand for `auth: { mode: "verifier", verifier }`; pass one',
		);
	if (auth === undefined) {
		if (typeof verifier !== "function")
			fail(
				'no verifier or auth. The console serves the owner\'s conversations and notes, so it will not start without a way to authenticate every request; pass `auth: { mode: "password" }`, `auth: { mode: "none" }` for a listener only the owner reaches, or `verifier: cloudflareAccess({...})` or your own',
			);
		return { mode: "verifier", verifier };
	}
	const mode = (auth as { mode?: unknown } | null)?.mode;
	const principal = (auth as { principal?: unknown }).principal;
	if (
		principal !== undefined &&
		(typeof principal !== "string" || !principal.trim())
	)
		fail(
			"auth.principal is empty. Leave it out to speak for the primary owner",
		);
	const named =
		typeof principal === "string" ? { principal: principal.trim() } : {};
	switch (mode) {
		case "none": {
			const { trustNetwork } = auth as { trustNetwork?: unknown };
			if (trustNetwork !== undefined && typeof trustNetwork !== "boolean")
				fail("auth.trustNetwork must be true or false");
			return { mode, trustNetwork: trustNetwork === true, ...named };
		}
		case "password": {
			const {
				passwordEnv = DEFAULT_PASSWORD_ENV,
				sessionDays = DEFAULT_SESSION_DAYS,
			} = auth as { passwordEnv?: unknown; sessionDays?: unknown };
			if (typeof passwordEnv !== "string" || !passwordEnv.trim())
				fail("auth.passwordEnv is empty");
			if (
				typeof sessionDays !== "number" ||
				!Number.isInteger(sessionDays) ||
				sessionDays < 1 ||
				sessionDays > 365
			)
				fail("auth.sessionDays must be a whole number of days from 1 to 365");
			return {
				mode,
				passwordEnv: passwordEnv.trim(),
				sessionDays,
				...named,
			};
		}
		case "verifier": {
			const given = (auth as { verifier?: unknown }).verifier;
			if (typeof given !== "function")
				fail(
					"auth.verifier is not a function; pass `cloudflareAccess({...})` or your own",
				);
			return { mode, verifier: given as RequestVerifier };
		}
		case "oidc":
			return checkOidc(auth as OidcOptions);
		default:
			fail(
				`auth.mode ${JSON.stringify(mode)} is unknown; the modes are none, password, verifier and oidc`,
			);
	}
}

const isHttpsUrl = (value: unknown): value is string =>
	typeof value === "string" && URL.parse(value)?.protocol === "https:";

/** A provider on this machine, which a test or a local identity provider may use over plain http. */
const isLoopbackHttp = (value: unknown): boolean => {
	const url = typeof value === "string" ? URL.parse(value) : null;
	return (
		url?.protocol === "http:" &&
		["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)
	);
};

const providerUrl = (value: unknown): value is string =>
	isHttpsUrl(value) || isLoopbackHttp(value);

function checkOidc(auth: OidcOptions): ResolvedOidc {
	const known = new Set([
		"mode",
		"issuer",
		"discoveryUrl",
		"clientId",
		"clientSecretEnv",
		"scopes",
		"subjectClaim",
		"nameClaim",
		"rolesClaim",
		"check",
		"sessionDays",
		"endSession",
		"reauthHours",
		"storeClaims",
		"onSessionVerified",
	]);
	for (const key of Object.keys(auth))
		if (!known.has(key)) fail(`auth.${key} is not an oidc option`);
	if (!providerUrl(auth.issuer))
		fail("auth.issuer must be the provider's https URL, exactly its `iss`");
	const { issuer } = auth;
	const discoveryUrl =
		auth.discoveryUrl ??
		`${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;
	if (!providerUrl(discoveryUrl))
		fail("auth.discoveryUrl must be an https URL");
	if (typeof auth.clientId !== "string" || !auth.clientId.trim())
		fail("auth.clientId is empty");
	if (
		auth.clientSecretEnv !== undefined &&
		(typeof auth.clientSecretEnv !== "string" || !auth.clientSecretEnv.trim())
	)
		fail(
			"auth.clientSecretEnv must name an environment variable; leave it out for a public client",
		);
	const scopes = auth.scopes ?? ["openid", "profile"];
	if (
		!Array.isArray(scopes) ||
		scopes.length === 0 ||
		!scopes.every(
			(scope) =>
				typeof scope === "string" && /^[\x21\x23-\x5b\x5d-\x7e]+$/.test(scope),
		)
	)
		fail("auth.scopes must be a list of scope names");
	if (scopes.includes("offline_access"))
		fail(
			"auth.scopes has offline_access, but the app keeps no refresh token: its own session is what lasts",
		);
	if (!scopes.includes("openid")) fail("auth.scopes must include openid");
	const claim = (name: string, value: unknown) => {
		if (value !== undefined && (typeof value !== "string" || !value.trim()))
			fail(`auth.${name} must be the name of a claim`);
	};
	claim("subjectClaim", auth.subjectClaim);
	claim("nameClaim", auth.nameClaim);
	if (
		auth.rolesClaim !== undefined &&
		auth.rolesClaim !== false &&
		(typeof auth.rolesClaim !== "string" || !auth.rolesClaim.trim())
	)
		fail("auth.rolesClaim must be the name of a claim, or false");
	if (auth.check !== undefined && typeof auth.check !== "function")
		fail("auth.check must be a function");
	const sessionDays = auth.sessionDays ?? DEFAULT_SESSION_DAYS;
	if (
		typeof sessionDays !== "number" ||
		!Number.isInteger(sessionDays) ||
		sessionDays < 1 ||
		sessionDays > 365
	)
		fail("auth.sessionDays must be a whole number of days from 1 to 365");
	if (auth.endSession !== undefined && typeof auth.endSession !== "boolean")
		fail("auth.endSession must be true or false");
	if (
		auth.reauthHours !== undefined &&
		(typeof auth.reauthHours !== "number" ||
			!(auth.reauthHours > 0) ||
			auth.reauthHours > sessionDays * 24)
	)
		fail(
			"auth.reauthHours must be a number of hours above 0 and within the session's own days",
		);
	const storeClaims = auth.storeClaims ?? [];
	if (
		!Array.isArray(storeClaims) ||
		!storeClaims.every((name) => typeof name === "string" && name.trim())
	)
		fail("auth.storeClaims must be a list of claim names");
	if (
		auth.onSessionVerified !== undefined &&
		typeof auth.onSessionVerified !== "function"
	)
		fail("auth.onSessionVerified must be a function");
	return {
		mode: "oidc",
		issuer,
		discoveryUrl,
		clientId: auth.clientId.trim(),
		clientSecretEnv: auth.clientSecretEnv?.trim(),
		scopes: [...scopes],
		subjectClaim: auth.subjectClaim?.trim() ?? "sub",
		nameClaim: auth.nameClaim?.trim(),
		rolesClaim:
			auth.rolesClaim === undefined
				? "roles"
				: typeof auth.rolesClaim === "string"
					? auth.rolesClaim.trim()
					: false,
		check: auth.check,
		sessionDays,
		endSession: auth.endSession === true,
		reauthHours: auth.reauthHours,
		storeClaims: [...storeClaims],
		onSessionVerified: auth.onSessionVerified,
	};
}
