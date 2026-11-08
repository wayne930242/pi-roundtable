/** A ContextForge in memory, served over HTTP: the admin calls the connectors plugin makes. */
export interface FakeContextForge {
	url: string;
	/**
	 * What an upstream URL offers; a gateway added for the URL brings these tools. A tool is its name,
	 * or its name with the MCP `annotations` ContextForge stores and lists for it, as it does in camelCase.
	 */
	upstream: Record<string, (string | { name: string; annotations: object })[]>;
	gateways: Map<string, { name: string; url: string; authType?: string }>;
	servers: Map<
		string,
		{ name: string; description: string; toolIds: string[] }
	>;
	/** Upstream URLs whose gateway refresh answers `success: false` with the given error. */
	refreshFails: Map<string, string>;
	/** Every admin request received, as `METHOD /path`, in order; `reset()` clears it. */
	requests: string[];
	/** When each request in `requests` arrived, in milliseconds. */
	requestTimes: number[];
	/**
	 * Like ContextForge's rate limit: once this many requests have been received, every later one is
	 * answered 429 and does nothing. Unset by default and by `reset()`.
	 */
	rateLimitAfter: number | undefined;
	/** Forgets every gateway, server, tool, and request. */
	reset(): void;
	stop(): void;
}

interface Tool {
	id: string;
	name: string;
	gatewaySlug: string;
	gatewayId: string;
	annotations: object;
}

export function fakeContextForge(): FakeContextForge {
	const tools: Tool[] = [];
	const state: Omit<FakeContextForge, "url" | "reset" | "stop"> = {
		upstream: {},
		gateways: new Map(),
		servers: new Map(),
		refreshFails: new Map(),
		requests: [],
		requestTimes: [],
		rateLimitAfter: undefined,
	};
	let next = 0;
	// The object tests hold, whose fields they change after the server has started.
	let fake: FakeContextForge | undefined;
	/** The tools a gateway has while its upstream offers what `upstream` lists for the URL. */
	const upstreamTools = (id: string, name: string, url: string): Tool[] =>
		(state.upstream[url] ?? []).map((tool) => {
			const upstream = typeof tool === "string" ? { name: tool } : tool;
			return {
				id: `${id}:${upstream.name}`,
				name: `${name}-${upstream.name}`,
				gatewaySlug: name,
				gatewayId: id,
				annotations: "annotations" in upstream ? upstream.annotations : {},
			};
		});
	const json = (body: unknown) => Response.json(body);
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(request) {
			const { pathname } = new URL(request.url);
			state.requests.push(`${request.method} ${pathname}`);
			state.requestTimes.push(Date.now());
			const limit = fake?.rateLimitAfter;
			if (limit !== undefined && state.requests.length > limit)
				return new Response("rate limit exceeded", { status: 429 });
			const sent = request.method === "POST" || request.method === "PUT";
			const raw = sent ? await request.text() : "";
			const body: Record<string, unknown> = raw ? JSON.parse(raw) : {};
			const refresh = /^\/gateways\/([^/]+)\/tools\/refresh$/.exec(pathname);
			if (refresh && request.method === "POST") {
				const id = refresh[1] ?? "";
				const gateway = state.gateways.get(id);
				if (!gateway) return new Response("not found", { status: 404 });
				const error = state.refreshFails.get(gateway.url);
				if (error !== undefined)
					return json({ gatewayId: id, success: false, error });
				// ContextForge keeps the tools that are still offered, drops the others, and adds the new ones.
				const offered = upstreamTools(id, gateway.name, gateway.url);
				const kept = tools.filter((t) => t.gatewayId !== id);
				const had = tools.filter((t) => t.gatewayId === id);
				tools.length = 0;
				tools.push(...kept, ...offered);
				return json({
					gatewayId: id,
					success: true,
					toolsAdded: offered.filter((o) => !had.some((h) => h.id === o.id))
						.length,
					toolsRemoved: had.filter((h) => !offered.some((o) => o.id === h.id))
						.length,
				});
			}
			if (pathname === "/tools") return json(tools);
			if (pathname === "/gateways" && request.method === "POST") {
				const name = String(body.name);
				const id = `gw${++next}`;
				state.gateways.set(id, {
					name,
					url: String(body.url),
					...(typeof body.auth_type === "string"
						? { authType: body.auth_type }
						: {}),
				});
				tools.push(...upstreamTools(id, name, String(body.url)));
				return json({ id, slug: name });
			}
			if (pathname === "/servers" && request.method === "POST") {
				const spec = body.server as {
					name: string;
					description: string;
					associated_tools: string[];
				};
				const id = `sv${++next}`;
				state.servers.set(id, {
					name: spec.name,
					description: spec.description,
					toolIds: spec.associated_tools,
				});
				return json({ id });
			}
			if (pathname === "/servers")
				return json(
					[...state.servers].map(([id, entry]) => ({ id, name: entry.name })),
				);
			const [, kind, id, tail] = pathname.split("/");
			if (kind === "servers" && request.method === "PUT") {
				const entry = state.servers.get(id ?? "");
				if (!entry) return new Response("not found", { status: 404 });
				if (Array.isArray(body.associated_tools))
					entry.toolIds = body.associated_tools.map(String);
				return json({ id });
			}
			if (request.method === "DELETE") {
				(kind === "servers" ? state.servers : state.gateways).delete(id ?? "");
				return json({});
			}
			const entry = state.servers.get(id ?? "");
			if (kind === "servers" && tail === "tools" && entry)
				return json(tools.filter((t) => entry.toolIds.includes(t.id)));
			return new Response("not found", { status: 404 });
		},
	});
	fake = {
		...state,
		reset: () => {
			tools.length = 0;
			state.gateways.clear();
			state.servers.clear();
			state.refreshFails.clear();
			state.requests.length = 0;
			state.requestTimes.length = 0;
			if (fake) fake.rateLimitAfter = undefined;
		},
		url: `http://127.0.0.1:${server.port}`,
		stop: () => void server.stop(true),
	};
	return fake;
}
