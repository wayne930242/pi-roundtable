import { ConnectorError } from "./connector-registry.ts";
import type { UpstreamAuth } from "./contextforge.ts";
import type { ConnectorMessages } from "./messages.ts";

const HEADER_NAME = /^[A-Za-z0-9-]{1,100}$/;

/** How a new connector authenticates upstream: no token is none, a token alone is a bearer token, a header name sends the token in that header. */
export function authFrom(
	header: string,
	token: string,
	text: ConnectorMessages,
): UpstreamAuth {
	if (!token) {
		if (header) throw new ConnectorError(text.headerNeedsToken);
		return { type: "none" };
	}
	if (!header) return { type: "bearer", token };
	if (!HEADER_NAME.test(header)) throw new ConnectorError(text.headerRule);
	return { type: "header", name: header, value: token };
}

/** Scheme and host only: some servers take their credential in the path, query, or user part. */
export function displayUrl(url: string, unreadable: string): string {
	const parsed = URL.parse(url);
	if (!parsed) return unreadable;
	const hidden =
		parsed.pathname !== "/" ||
		parsed.search ||
		parsed.hash ||
		parsed.username ||
		parsed.password;
	return `${parsed.origin}${hidden ? "/…" : ""}`;
}
