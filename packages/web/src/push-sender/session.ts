import { createHash } from "node:crypto";
import type { SQL } from "bun";
import { WebSessions } from "../auth/sessions.ts";

/** The session cookie the app sets: `__Secure-` because the console is never served at the root. */
export const SESSION_COOKIE = "__Secure-rt_session";

const cookieValue = (
	header: string | null,
	name: string,
): string | undefined => {
	for (const part of (header ?? "").split(";")) {
		const at = part.indexOf("=");
		if (at > 0 && part.slice(0, at).trim() === name)
			return part.slice(at + 1).trim();
	}
	return undefined;
};

/**
 * Looks the app's session cookie up in `web_sessions` (read only) and answers the principal it
 * belongs to, or undefined for a cookie that names no session, a session past its limit, or a
 * principal that is disabled. The cookie holds a random id; only its SHA-256 is stored.
 */
export function webSessionPrincipal(options: {
	database: SQL;
	/** The cookie's name; default the app's own. */
	cookieName?: string;
}): (request: Request) => Promise<string | undefined> {
	const name = options.cookieName ?? SESSION_COOKIE;
	return async (request) => {
		const token = cookieValue(request.headers.get("cookie"), name);
		if (!token) return undefined;
		const [found]: { principal_id: string }[] = await options.database`
			SELECT s.principal_id FROM web_sessions s
			JOIN principals p ON p.id = s.principal_id
			WHERE s.id_hash = ${createHash("sha256").update(token).digest()}
				AND s.expires_at > now() AND p.disabled_at IS NULL`;
		return found?.principal_id;
	};
}

/**
 * The id_token claims `oidc.storeClaims` kept for a person, from their newest live session;
 * undefined when they have no live session or kept no claims. For a sender that needs, say, the
 * person's mailbox address. Claims are the host's own data: never log them.
 */
export function webSessionClaims(
	database: SQL,
	principalId: string,
): Promise<Readonly<Record<string, unknown>> | undefined> {
	// The idle limit only matters for creating a session; reading one does not use it.
	return new WebSessions(database, { days: 30 }).claimsOf(principalId);
}
