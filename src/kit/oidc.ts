/**
 * The identity provider of an OpenID issuer, as `access.owners[].identities`, `selfLink.providers`
 * and `ActorFacts.provider` write it: `oidc:<base64url(issuer)>`. The issuer is encoded so its own
 * colons stay apart from the subject's.
 */
export function oidcProvider(issuer: string): string {
	return `oidc:${Buffer.from(issuer).toString("base64url")}`;
}

/**
 * The identity of one OpenID subject, `oidcProvider(issuer)` and the subject: the form
 * `roundtable principal link` and `access.owners[].identities` take, and the 0.8 web speaker id.
 */
export function oidcIdentity(issuer: string, subject: string): string {
	return `${oidcProvider(issuer)}:${subject}`;
}
