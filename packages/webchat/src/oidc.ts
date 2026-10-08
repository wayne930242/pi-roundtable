import {
	createRemoteJWKSet,
	type JWSAlgorithm,
	type JWTPayload,
	type JWTVerifyGetKey,
	jwtVerify,
} from "jose";
import type { ActorFacts } from "pi-roundtable";

/** Who a verified token names, and until when it may be trusted. */
export interface WebIdentity {
	/** Verified actor facts for the core identity service; custom verifiers may supply their own provider. */
	actor?: ActorFacts;
	/** The speaker id: reversible and unique across issuers, such as `oidc:<base64url(issuer)>:<sub>`. */
	id: string;
	/** How the person is shown, from the token's name claim. */
	name: string;
	/** The token's role or group claim; the access policy maps these to a tier. */
	roles: readonly string[];
	/** When the token expires; a connection asks for a fresh one before then. */
	expiresAt: Date;
}

/**
 * Checks one bearer token and names who it vouches for, or throws `TokenRefused`. The webchat
 * calls it for every REST request, every WebSocket upgrade, and every `auth` frame.
 */
export type TokenVerifier = (token: string) => Promise<WebIdentity>;

/** A token was refused; `reason` is for the operator's log, never sent to the client, and never holds the token. */
export class TokenRefused extends Error {
	override name = "TokenRefused";
	readonly reason: string;

	constructor(reason: string) {
		super(`token refused: ${reason}`);
		this.reason = reason;
	}
}

const PREFIX = "oidc";

/**
 * The speaker id of an OpenID subject: `oidc:<base64url(issuer)>:<subject>`. The issuer is
 * encoded so its own colons stay apart from the subject's, and the id can be turned back into the
 * pair with `parseOidcSpeakerId`. It never looks like a Discord id.
 */
export function oidcSpeakerId(issuer: string, subject: string): string {
	return `${PREFIX}:${Buffer.from(issuer).toString("base64url")}:${subject}`;
}

/** The issuer and subject of an id `oidcSpeakerId` made; undefined for any other id. */
export function parseOidcSpeakerId(
	id: string,
): { issuer: string; subject: string } | undefined {
	const match = /^oidc:([A-Za-z0-9_-]+):(.+)$/.exec(id);
	if (!match) return undefined;
	const [, encoded = "", subject = ""] = match;
	const issuer = Buffer.from(encoded, "base64url").toString("utf8");
	// A round trip that does not give the same text back was not base64url of an issuer.
	if (Buffer.from(issuer).toString("base64url") !== encoded) return undefined;
	return { issuer, subject };
}

/** Core facts for a verified identity, with roles scoped to this chat's surface. */
export function identityActor(
	identity: WebIdentity,
	surface = "web",
): ActorFacts {
	const oidc = parseOidcSpeakerId(identity.id);
	return {
		...(identity.actor ?? {
			provider: oidc
				? `oidc:${Buffer.from(oidc.issuer).toString("base64url")}`
				: surface,
			subject: oidc?.subject ?? identity.id,
			legacyId: identity.id,
		}),
		name: identity.name,
		surface,
		roles: identity.roles.map((role) => `${surface}:role:${role}`),
	};
}

export interface OidcJwtVerifierOptions {
	/** The provider's published signing keys (`jwks_uri`): https, or http on a loopback address. */
	jwksUrl: string;
	/** The `iss` values accepted, exactly as the provider writes them. */
	issuers: readonly string[];
	/** The `aud` values accepted: the client id or application id URI of this API. */
	audiences: readonly string[];
	/**
	 * The issuer speaker ids are made from. Required when `issuers` lists several issuers of one
	 * provider (such as two token versions), so one person keeps one id whichever issued the token.
	 */
	speakerIssuer?: string;
	/** The claim naming the person; default `sub`. A provider's stable object id claim may suit better. */
	subjectClaim?: string;
	/** The claim to show the person by; default `name`, then `preferred_username`, then the subject. */
	nameClaim?: string;
	/** The claim holding their roles or groups, an array of strings; default `roles`. */
	rolesClaim?: string;
	/** Accepted signature algorithms; default RS256 and ES256. Symmetric algorithms and `none` are refused. */
	algorithms?: readonly string[];
	/** How far `exp` and `nbf` may be off the local clock; default 60 seconds. */
	clockSkewSeconds?: number;
	/** A further check on the verified claims, such as a tenant claim; false refuses the token. */
	check?(claims: Readonly<JWTPayload & Record<string, unknown>>): boolean;
	/**
	 * Refuses a token without a scope (`scp` or `scope`) or app roles (`roles`), the marks of an
	 * access token; default true. An ID token carries no scope, so one whose `aud` happens to be
	 * this API's client id cannot pass for an access token. Set false only for a provider whose
	 * access tokens carry neither.
	 */
	requireScopeOrRoles?: boolean;
	/**
	 * Refuses an app-only token, one a service got for itself with no person behind it
	 * (`idtyp: "app"`, as Microsoft Entra ID writes it); default true.
	 */
	rejectAppOnly?: boolean;
	/** Replaces the JWKS fetch, for a test or a host that already holds the keys. */
	keys?: JWTVerifyGetKey;
	/** How long the fetched key set is reused before it is fetched again; default 10 minutes. */
	cacheMaxAgeMs?: number;
	/**
	 * The least time between two fetches for a key id the cached set lacks, such as after the
	 * provider rotated its keys; default 30 seconds, so unknown key ids cannot flood the provider.
	 */
	refetchCooldownMs?: number;
}

const DEFAULT_ALGORITHMS = ["RS256", "ES256"] as const;
/** The JWS algorithms with a public key, the only kind a published key set can verify. */
const ASYMMETRIC =
	/^(RS(256|384|512)|PS(256|384|512)|ES(256|384|512)|ES256K|EdDSA|Ed25519)$/;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

function configError(message: string): Error {
	return new Error(`oidcJwtVerifier: ${message}`);
}

function keySource(options: OidcJwtVerifierOptions): JWTVerifyGetKey {
	if (options.keys) return options.keys;
	const url = URL.parse(options.jwksUrl);
	if (!url) throw configError(`jwksUrl ${options.jwksUrl} is not a URL`);
	if (
		url.protocol !== "https:" &&
		!(url.protocol === "http:" && LOOPBACK.has(url.hostname))
	)
		throw configError(
			"jwksUrl must use https (http only on a loopback address), so the keys cannot be swapped in transit",
		);
	return createRemoteJWKSet(url, {
		cacheMaxAge: options.cacheMaxAgeMs ?? 10 * 60_000,
		cooldownDuration: options.refetchCooldownMs ?? 30_000,
		timeoutDuration: 5_000,
	});
}

function algorithmsOf(options: OidcJwtVerifierOptions): JWSAlgorithm[] {
	const algorithms = options.algorithms ?? DEFAULT_ALGORITHMS;
	if (algorithms.length === 0)
		throw configError("algorithms is empty; leave it out for RS256 and ES256");
	for (const alg of algorithms)
		if (!ASYMMETRIC.test(alg))
			throw configError(
				`algorithm ${alg} cannot be verified with a published key; use an asymmetric one such as RS256 or ES256`,
			);
	return [...algorithms];
}

function speakerIssuerOf(options: OidcJwtVerifierOptions): string | undefined {
	const { issuers, speakerIssuer } = options;
	if (speakerIssuer !== undefined && !issuers.includes(speakerIssuer))
		throw configError(
			`speakerIssuer ${speakerIssuer} is not one of the accepted issuers`,
		);
	if (issuers.length > 1 && speakerIssuer === undefined)
		throw configError(
			"issuers lists several issuers: set speakerIssuer to the one speaker ids are made from, so one person keeps one id",
		);
	return speakerIssuer;
}

const text = (value: unknown): string | undefined =>
	typeof value === "string" && value.trim() !== "" ? value : undefined;

/** A claim with something in it: non-blank text, or a list with a non-blank text. */
const filled = (value: unknown): boolean =>
	text(value) !== undefined ||
	(Array.isArray(value) && value.some((item) => text(item) !== undefined));

/**
 * Verifies OpenID Connect access tokens against a provider's published keys: the signature
 * with an allowed asymmetric algorithm, `iss`, `aud`, `exp` (required), and `nbf`, within the
 * clock skew; by default a scope or app roles (`requireScopeOrRoles`) and no app-only token
 * (`rejectAppOnly`); then `sub` (or `subjectClaim`) and the optional `check`. The key set is fetched when
 * first needed, cached, and fetched again for a key id it does not hold, at most every `refetchCooldownMs`.
 * Configuration mistakes throw at construction, so a host with a broken verifier does not start.
 */
export function oidcJwtVerifier(
	options: OidcJwtVerifierOptions,
): TokenVerifier {
	if (options.issuers.length === 0 || options.issuers.some((i) => !text(i)))
		throw configError("issuers is empty; list the provider's iss values");
	if (options.audiences.length === 0 || options.audiences.some((a) => !text(a)))
		throw configError("audiences is empty; list this API's aud values");
	const keys = keySource(options);
	const algorithms = algorithmsOf(options);
	const speakerIssuer = speakerIssuerOf(options);
	const subjectClaim = options.subjectClaim ?? "sub";
	const rolesClaim = options.rolesClaim ?? "roles";
	const clockTolerance = options.clockSkewSeconds ?? 60;
	return async (token) => {
		if (!token) throw new TokenRefused("no token");
		let claims: JWTPayload & Record<string, unknown>;
		try {
			({ payload: claims } = await jwtVerify(token, keys, {
				issuer: [...options.issuers],
				audience: [...options.audiences],
				algorithms,
				clockTolerance,
				requiredClaims: ["exp", "iss", "aud"],
			}));
		} catch (error) {
			throw new TokenRefused(
				error instanceof Error ? error.message : "invalid token",
			);
		}
		if (
			options.requireScopeOrRoles !== false &&
			!filled(claims.scp) &&
			!filled(claims.scope) &&
			!filled(claims.roles)
		)
			throw new TokenRefused(
				"the token carries no scope or roles, so it is not an access token for this API",
			);
		if (options.rejectAppOnly !== false && claims.idtyp === "app")
			throw new TokenRefused("an app-only token names no person");
		const subject = text(claims[subjectClaim]);
		if (!subject)
			throw new TokenRefused(`the "${subjectClaim}" claim is missing`);
		if (options.check && !options.check(claims))
			throw new TokenRefused("the configured check refused the claims");
		const roles = claims[rolesClaim];
		const name =
			text(options.nameClaim ? claims[options.nameClaim] : claims.name) ??
			text(claims.preferred_username) ??
			subject;
		const issuer = speakerIssuer ?? (claims.iss as string);
		const id = oidcSpeakerId(issuer, subject);
		const roleNames = Array.isArray(roles)
			? roles.filter((role): role is string => typeof role === "string")
			: [];
		return {
			actor: {
				provider: `oidc:${Buffer.from(issuer).toString("base64url")}`,
				subject,
				name,
				surface: "web",
				legacyId: id,
				roles: roleNames.map((role) => `web:role:${role}`),
			},
			id,
			name,
			roles: roleNames,
			expiresAt: new Date((claims.exp as number) * 1000),
		};
	};
}
