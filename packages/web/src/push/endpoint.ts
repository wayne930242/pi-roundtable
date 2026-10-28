/** The push services of the browsers that support Web Push; `push.endpointHosts` adds to them. */
const PUSH_HOSTS: readonly string[] = [
	"fcm.googleapis.com",
	"updates.push.services.mozilla.com",
	"*.push.apple.com",
	"*.notify.windows.com",
];

/** A host name as `push.endpointHosts` writes it: lower-case labels, with `*.` first to mean any subdomain. */
const HOST_PATTERN = /^(\*\.)?([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/;

export function isHostPattern(value: string): boolean {
	return HOST_PATTERN.test(value);
}

/**
 * Which push-service endpoints the server posts to. A subscription's endpoint is a URL the
 * browser hands over, so without this check any owner session could make the host fetch any
 * address: the endpoint must be `https` on the default port, with no credentials, and its host
 * must be one of the allowed.
 */
export class EndpointPolicy {
	readonly #exact = new Set<string>();
	readonly #suffixes: string[] = [];

	constructor(extra: readonly string[] = []) {
		for (const host of [...PUSH_HOSTS, ...extra]) {
			if (host.startsWith("*.")) this.#suffixes.push(host.slice(1));
			else this.#exact.add(host);
		}
	}

	/** The endpoint as a URL, or why it is refused. */
	check(endpoint: unknown): { url: URL } | { refusal: string } {
		if (typeof endpoint !== "string" || endpoint.length > 2048)
			return { refusal: "The push endpoint is not a URL." };
		const url = URL.parse(endpoint);
		if (!url) return { refusal: "The push endpoint is not a URL." };
		if (url.protocol !== "https:")
			return { refusal: "The push endpoint must be https." };
		if (url.username || url.password || url.port || url.hash)
			return {
				refusal:
					"The push endpoint must have no credentials, port or fragment.",
			};
		const host = url.hostname;
		if (
			!this.#exact.has(host) &&
			!this.#suffixes.some((suffix) => host.endsWith(suffix))
		)
			return { refusal: "That push service is not allowed." };
		return { url };
	}
}
