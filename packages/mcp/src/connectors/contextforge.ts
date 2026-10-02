import { createHmac, randomUUID } from "node:crypto";
import { ConfigError } from "pi-roundtable";
import type { VirtualServer } from "pi-roundtable/kit";
import { CONNECTOR_MESSAGES, type ConnectorMessages } from "./messages.ts";

function base64url(value: string | Buffer): string {
	return Buffer.from(value).toString("base64url");
}

/**
 * An admin token with the claims ContextForge's own `create_jwt_token --admin` issues,
 * signed HS256 with its JWT secret. `teams: null` gives the admin bypass.
 */
export function contextForgeToken(
	secret: string,
	user: string,
	ttlSeconds: number,
	now = Math.floor(Date.now() / 1000),
): string {
	const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
	const payload = base64url(
		JSON.stringify({
			username: user,
			sub: user,
			iat: now,
			exp: now + ttlSeconds,
			iss: "mcpgateway",
			aud: "mcpgateway-api",
			jti: randomUUID(),
			env: "development",
			user: {
				email: user,
				full_name: "pi-roundtable-mcp",
				is_admin: true,
				auth_provider: "cli",
			},
			teams: null,
		}),
	);
	const signature = createHmac("sha256", secret)
		.update(`${header}.${payload}`)
		.digest("base64url");
	return `${header}.${payload}.${signature}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function getJson(
	url: string,
	token: string,
	fetchImpl: typeof fetch,
	text: ConnectorMessages,
): Promise<unknown> {
	const response = await fetchImpl(url, {
		headers: { authorization: `Bearer ${token}` },
		signal: AbortSignal.timeout(15_000),
	});
	if (!response.ok) {
		throw new ConfigError(
			text.virtualServerRequestFailed(
				url,
				response.status,
				(await response.text()).slice(0, 200),
			),
		);
	}
	return response.json();
}

/** Finds a virtual server by name and lists the tool names it serves. */
export async function resolveVirtualServer(
	baseUrl: string,
	token: string,
	name: string,
	fetchImpl: typeof fetch = fetch,
	text: ConnectorMessages = CONNECTOR_MESSAGES,
): Promise<VirtualServer> {
	const servers = await getJson(
		`${baseUrl}/servers?include_pagination=false`,
		token,
		fetchImpl,
		text,
	);
	const server = Array.isArray(servers)
		? servers.find((entry) => isRecord(entry) && entry.name === name)
		: undefined;
	if (!isRecord(server) || typeof server.id !== "string") {
		throw new ConfigError(text.virtualServerMissing(name));
	}
	const tools = await getJson(
		`${baseUrl}/servers/${server.id}/tools?include_pagination=false`,
		token,
		fetchImpl,
		text,
	);
	const names = Array.isArray(tools)
		? tools.flatMap((tool) =>
				isRecord(tool) && typeof tool.name === "string" ? [tool.name] : [],
			)
		: [];
	if (names.length === 0)
		throw new ConfigError(text.virtualServerNoTools(name));
	return { name, url: `${baseUrl}/servers/${server.id}/mcp`, tools: names };
}

/** A request ContextForge refused or could not complete; the message is safe to show the owner. */
export class ContextForgeError extends Error {}

/** How ContextForge authenticates to an upstream MCP server. */
export type UpstreamAuth =
	| { type: "none" }
	| { type: "bearer"; token: string }
	| { type: "header"; name: string; value: string };

/** The credential as ContextForge's gateway form takes it. */
function authFields(auth: UpstreamAuth): Record<string, string> {
	if (auth.type === "bearer")
		return { auth_type: "bearer", auth_token: auth.token };
	if (auth.type === "header")
		return {
			auth_type: "authheaders",
			auth_header_key: auth.name,
			auth_header_value: auth.value,
		};
	return {};
}

/** The parts of the credential that error text must not repeat. */
function authSecrets(auth: UpstreamAuth): string[] {
	if (auth.type === "bearer") return [auth.token];
	if (auth.type === "header") return [auth.value];
	return [];
}

export interface GatewayTool {
	id: string;
	name: string;
	gatewaySlug: string;
}

/** The admin API calls that add and remove owner connectors. */
export interface GatewayState {
	name: string;
	enabled: boolean;
	reachable: boolean;
	tools: number;
}

export class ContextForgeAdmin {
	readonly #baseUrl: string;
	readonly #token: string;
	readonly #fetch: typeof fetch;
	readonly #text: ConnectorMessages;

	constructor(
		baseUrl: string,
		token: string,
		fetchImpl: typeof fetch = fetch,
		text: ConnectorMessages = CONNECTOR_MESSAGES,
	) {
		this.#baseUrl = baseUrl;
		this.#token = token;
		this.#fetch = fetchImpl;
		this.#text = text;
	}

	/** Registers an upstream server; ContextForge connects and lists its tools before answering. */
	async createGateway(gateway: {
		name: string;
		url: string;
		description: string;
		auth: UpstreamAuth;
	}): Promise<{ id: string; slug: string }> {
		const { auth } = gateway;
		const upstream = URL.parse(gateway.url);
		if (!upstream)
			throw new ContextForgeError(
				this.#text.upstreamUrlUnreadable(gateway.url),
			);
		const body = {
			name: gateway.name,
			url: gateway.url,
			description: gateway.description,
			transport: /\/sse\/?$/.test(upstream.pathname) ? "SSE" : "STREAMABLEHTTP",
			...authFields(auth),
		};
		const secrets = [...authSecrets(auth), ...urlSecrets(gateway.url)];
		const created = await this.#send(
			"POST",
			"/gateways",
			body,
			90_000,
			secrets,
		);
		if (!isRecord(created) || typeof created.id !== "string")
			throw new ContextForgeError(this.#text.contextForgeNoGatewayId);
		return {
			id: created.id,
			slug: typeof created.slug === "string" ? created.slug : gateway.name,
		};
	}

	async tools(): Promise<GatewayTool[]> {
		const tools = await this.#send(
			"GET",
			"/tools?include_pagination=false&limit=0",
		);
		return Array.isArray(tools)
			? tools.flatMap((tool) =>
					isRecord(tool) &&
					typeof tool.id === "string" &&
					typeof tool.name === "string" &&
					typeof tool.gatewaySlug === "string"
						? [{ id: tool.id, name: tool.name, gatewaySlug: tool.gatewaySlug }]
						: [],
				)
			: [];
	}

	/** Every upstream gateway with its state and tool count; URLs and auth are never read. */
	async gateways(): Promise<GatewayState[]> {
		const [gateways, tools] = await Promise.all([
			this.#send("GET", "/gateways?include_pagination=false"),
			this.tools(),
		]);
		return Array.isArray(gateways)
			? gateways.flatMap((gateway) =>
					isRecord(gateway) && typeof gateway.name === "string"
						? [
								{
									name: gateway.name,
									enabled: gateway.enabled === true,
									reachable: gateway.reachable === true,
									tools: tools.filter(
										(tool) =>
											tool.gatewaySlug ===
											(typeof gateway.slug === "string"
												? gateway.slug
												: gateway.name),
									).length,
								},
							]
						: [],
				)
			: [];
	}

	/** Every virtual server with the names of the tools it serves. */
	async servers(): Promise<{ name: string; tools: string[] }[]> {
		const servers = await this.#send(
			"GET",
			"/servers?include_pagination=false",
		);
		const named = Array.isArray(servers)
			? servers.filter(
					(server): server is { id: string; name: string } =>
						isRecord(server) &&
						typeof server.id === "string" &&
						typeof server.name === "string",
				)
			: [];
		return Promise.all(
			named.map(async (server) => {
				const tools = await this.#send(
					"GET",
					`/servers/${encodeURIComponent(server.id)}/tools?include_pagination=false`,
				);
				return {
					name: server.name,
					tools: Array.isArray(tools)
						? tools.flatMap((tool) =>
								isRecord(tool) && typeof tool.name === "string"
									? [tool.name]
									: [],
							)
						: [],
				};
			}),
		);
	}

	async createServer(
		name: string,
		description: string,
		toolIds: string[],
	): Promise<string> {
		const created = await this.#send("POST", "/servers", {
			server: { name, description, associated_tools: toolIds },
		});
		if (!isRecord(created) || typeof created.id !== "string")
			throw new ContextForgeError(this.#text.contextForgeNoServerId);
		return created.id;
	}

	async deleteServer(id: string): Promise<void> {
		await this.#send("DELETE", `/servers/${encodeURIComponent(id)}`);
	}

	async deleteGateway(id: string): Promise<void> {
		await this.#send("DELETE", `/gateways/${encodeURIComponent(id)}`);
	}

	async #send(
		method: string,
		path: string,
		body?: unknown,
		timeoutMs = 30_000,
		/** Masked in error text, since a validation error may echo the request. */
		secrets: readonly string[] = [],
	): Promise<unknown> {
		const response = await this.#fetch(`${this.#baseUrl}${path}`, {
			method,
			headers: {
				authorization: `Bearer ${this.#token}`,
				...(body === undefined ? {} : { "content-type": "application/json" }),
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
			signal: AbortSignal.timeout(timeoutMs),
		});
		const text = await response.text();
		if (!response.ok)
			throw new ContextForgeError(
				this.#text.contextForgeRefused(
					response.status,
					detailOf(masked(text, secrets)),
				),
			);
		if (!text) return undefined;
		try {
			return JSON.parse(text);
		} catch {
			throw new ContextForgeError(
				this.#text.contextForgeNotJson(detailOf(masked(text, secrets))),
			);
		}
	}
}

/**
 * The parts of an upstream URL that may carry a credential: the URL itself, what follows
 * its host, user and password, and query values. Short parts are left, since masking them
 * would garble the rest of the message.
 */
export function urlSecrets(url: string): string[] {
	const parsed = URL.parse(url);
	if (!parsed) return [url];
	const rest = `${parsed.pathname}${parsed.search}${parsed.hash}`;
	return [
		url,
		parsed.href,
		rest === "/" ? "" : rest,
		parsed.username,
		parsed.password,
		...parsed.searchParams.values(),
		...[...parsed.searchParams.values()].map(encodeURIComponent),
	].filter((part) => part.length >= 4);
}

/** The text with the secrets removed, raw or JSON-escaped once or twice; longest first. */
function masked(text: string, secrets: readonly string[]): string {
	const forms = secrets.flatMap((secret) => {
		const once = JSON.stringify(secret).slice(1, -1);
		return [secret, once, JSON.stringify(once).slice(1, -1)];
	});
	return [...new Set(forms)]
		.sort((a, b) => b.length - a.length)
		.reduce((result, form) => result.replaceAll(form, "***"), text);
}

/** ContextForge's error detail, shortened. */
function detailOf(text: string): string {
	try {
		const parsed: unknown = JSON.parse(text);
		if (isRecord(parsed)) {
			const detail = parsed.detail ?? parsed.message;
			return (
				typeof detail === "string" ? detail : JSON.stringify(detail)
			).slice(0, 300);
		}
	} catch {
		// Not JSON: the raw text below is the detail.
	}
	return text.slice(0, 300);
}
