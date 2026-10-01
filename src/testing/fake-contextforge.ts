/** A ContextForge in memory, served over HTTP: the admin calls the connectors plugin makes. */
export interface FakeContextForge {
	url: string;
	/** What an upstream URL offers, by tool name; a gateway added for the URL brings these tools. */
	upstream: Record<string, string[]>;
	gateways: Map<string, { name: string; url: string; authType?: string }>;
	servers: Map<
		string,
		{ name: string; description: string; toolIds: string[] }
	>;
	/** Forgets every gateway, server, and tool. */
	reset(): void;
	stop(): void;
}

interface Tool {
	id: string;
	name: string;
	gatewaySlug: string;
}

export function fakeContextForge(): FakeContextForge {
	const tools: Tool[] = [];
	const state: Omit<FakeContextForge, "url" | "reset" | "stop"> = {
		upstream: {},
		gateways: new Map(),
		servers: new Map(),
	};
	let next = 0;
	const json = (body: unknown) => Response.json(body);
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(request) {
			const { pathname } = new URL(request.url);
			const body: Record<string, unknown> =
				request.method === "POST"
					? ((await request.json()) as Record<string, unknown>)
					: {};
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
				for (const tool of state.upstream[String(body.url)] ?? [])
					tools.push({
						id: `${id}:${tool}`,
						name: `${name}-${tool}`,
						gatewaySlug: name,
					});
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
	return {
		...state,
		reset: () => {
			tools.length = 0;
			state.gateways.clear();
			state.servers.clear();
		},
		url: `http://127.0.0.1:${server.port}`,
		stop: () => void server.stop(true),
	};
}
