import { createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from "jose";
import { admitAs, type RequestVerifier, refuse } from "./verifier.ts";

export interface CloudflareAccessOptions {
	/** The Access team domain, such as `example.cloudflareaccess.com`. */
	teamDomain: string;
	/** The AUD tag of the Access application in front of the console. */
	audience: string;
	/**
	 * The email, or emails, Access may vouch for; compared without regard to case. The console
	 * then admits only those whose identity is linked to an owner: see `cloudflareAccessIdentity`.
	 */
	email: string | readonly string[];
	/** Replaceable in tests; the team's published signing keys otherwise. */
	keys?: JWTVerifyGetKey;
}

const HEADER = "cf-access-jwt-assertion";

/** The identity provider of an Access team's users: `oidc:<base64url(https://<teamDomain>)>`. */
const providerOf = (issuer: string) =>
	`oidc:${Buffer.from(issuer).toString("base64url")}`;

/**
 * The identity, as `access.owners[].identities` and `roundtable principal link` write it, of the
 * Access user `sub` (the user id in the token) of a team: `oidc:<base64url(issuer)>:<sub>`, the
 * form any OpenID issuer's users take.
 */
export function cloudflareAccessIdentity(
	teamDomain: string,
	sub: string,
): string {
	return `${providerOf(`https://${teamDomain.trim()}`)}:${sub}`;
}

/**
 * Admits a request only when Cloudflare Access vouches for an allowed email: its
 * `Cf-Access-Jwt-Assertion` header holds a token signed by the team's keys, issued by the team,
 * for this application, naming that email and a user. The token is checked on every request, so
 * the console stays closed to a client that reaches it without passing through Access. It reports
 * the user as an OpenID identity of the team's issuer, their `sub` as the subject and their email
 * as the name.
 */
export function cloudflareAccess(
	options: CloudflareAccessOptions,
): RequestVerifier {
	const teamDomain = options.teamDomain.trim();
	const audience = options.audience.trim();
	const emails = (
		typeof options.email === "string" ? [options.email] : options.email
	).map((email) => email.trim().toLowerCase());
	if (!teamDomain || teamDomain.includes("/"))
		throw new Error(
			"cloudflareAccess: teamDomain must be a host name such as example.cloudflareaccess.com",
		);
	if (!audience) throw new Error("cloudflareAccess: audience is empty");
	if (emails.length === 0 || emails.some((email) => !email))
		throw new Error("cloudflareAccess: email names no one");
	const keys =
		options.keys ??
		createRemoteJWKSet(new URL(`https://${teamDomain}/cdn-cgi/access/certs`));
	const issuer = `https://${teamDomain}`;
	const provider = providerOf(issuer);
	return async (request) => {
		const token = request.headers.get(HEADER);
		if (!token) return refuse("no Access token");
		let email: string;
		let subject: string;
		try {
			const { payload } = await jwtVerify(token, keys, { issuer, audience });
			if (
				typeof payload.email !== "string" ||
				!emails.includes(payload.email.toLowerCase())
			)
				return refuse("email not allowed");
			if (typeof payload.sub !== "string" || !payload.sub)
				return refuse("Access token names no user");
			email = payload.email.toLowerCase();
			subject = payload.sub;
		} catch {
			return refuse("invalid Access token");
		}
		return admitAs({ provider, subject, name: email });
	};
}
