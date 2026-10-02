import { createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from "jose";
import { admit, type RequestVerifier, refuse } from "./verifier.ts";

export interface CloudflareAccessOptions {
	/** The Access team domain, such as `example.cloudflareaccess.com`. */
	teamDomain: string;
	/** The AUD tag of the Access application in front of the console. */
	audience: string;
	/** The email, or emails, Access may vouch for; compared without regard to case. */
	email: string | readonly string[];
	/** Replaceable in tests; the team's published signing keys otherwise. */
	keys?: JWTVerifyGetKey;
}

const HEADER = "cf-access-jwt-assertion";

/**
 * Admits a request only when Cloudflare Access vouches for an allowed email: its
 * `Cf-Access-Jwt-Assertion` header holds a token signed by the team's keys, issued by the team,
 * for this application, naming that email. The token is checked on every request, so the
 * console stays closed to a client that reaches it without passing through Access.
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
	return async (request) => {
		const token = request.headers.get(HEADER);
		if (!token) return refuse("no Access token");
		try {
			const { payload } = await jwtVerify(token, keys, {
				issuer: `https://${teamDomain}`,
				audience,
			});
			if (
				typeof payload.email !== "string" ||
				!emails.includes(payload.email.toLowerCase())
			)
				return refuse("email not allowed");
		} catch {
			return refuse("invalid Access token");
		}
		return admit();
	};
}
