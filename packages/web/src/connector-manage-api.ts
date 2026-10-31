import type { Logger } from "pi-roundtable";
import type {
	ConnectorAddedView,
	ManagedConnectorView,
	McpAuthorizeInput,
	McpChannelView,
	McpGrantsView,
	McpUrlView,
} from "./api-types.ts";
import type {
	ConnectorManagement,
	ConsoleActor,
	ManagedConnector,
	McpGrants,
} from "./features.ts";
import { ConsoleHttpError as HttpError, json } from "./http.ts";

/** What the routes below `connectors/` need besides the ports. */
export interface ManageContext {
	logger: Logger;
	actor: ConsoleActor;
	/** Reads the request's JSON body, or undefined when it is not JSON. */
	body(): Promise<unknown>;
	/** Tells the open pages that something changed. */
	changed(): void;
}

const CONNECTORS_DOWN =
	"The connector service did not respond. Try again later.";
const GRANTS_DOWN =
	"The MCP authorization service did not respond. Try again later.";

/**
 * Scheme and host only: some servers take their credential in the path, query, or user part.
 * Undefined for a URL that cannot be parsed.
 */
export function displayUrl(url: string): string | undefined {
	const parsed = URL.parse(url);
	if (!parsed) return undefined;
	const hidden =
		parsed.pathname !== "/" ||
		parsed.search ||
		parsed.hash ||
		parsed.username ||
		parsed.password;
	return `${parsed.origin}${hidden ? "/…" : ""}`;
}

/** Only the fields the page shows, so nothing else the port's object holds can reach a response. */
function connectorView(connector: ManagedConnector): ManagedConnectorView {
	const shown = displayUrl(connector.url);
	return {
		name: connector.name,
		...(shown ? { displayUrl: shown } : {}),
		description: connector.description,
		...(connector.server ? { tools: connector.server.tools.length } : {}),
	};
}

/**
 * A port's refusal reaches the owner as its message, already in the host's wording; anything
 * else is logged without the request and answered as the service being down.
 */
async function guarded<T>(
	context: ManageContext,
	service: "connectors" | "grants",
	call: () => Promise<T> | T,
): Promise<T> {
	try {
		return await call();
	} catch (error) {
		if (error instanceof HttpError) throw error;
		if (
			error instanceof Error &&
			(error as { refusal?: unknown }).refusal === true
		)
			throw new HttpError(400, error.message);
		context.logger.error({ err: error }, "connector management failed");
		if (service === "grants") throw new HttpError(502, GRANTS_DOWN);
		throw new HttpError(502, CONNECTORS_DOWN);
	}
}

const optional = (value: unknown, max: number): string | undefined => {
	if (value === undefined || value === null || value === "") return undefined;
	if (typeof value !== "string" || value.length > max)
		throw new HttpError(400, "The body is not valid.");
	return value;
};

const required = (value: unknown, max: number): string => {
	if (typeof value !== "string" || value.length > max)
		throw new HttpError(400, "The body is not valid.");
	return value;
};

async function objectBody(
	context: ManageContext,
): Promise<Record<string, unknown>> {
	const body = await context.body();
	if (typeof body !== "object" || body === null || Array.isArray(body))
		throw new HttpError(400, "The body is not valid.");
	return body as Record<string, unknown>;
}

/** `connectors/managed[/<name>]`: list, add, change the purpose of, and remove connectors. */
export async function connectorRoutes(
	manage: ConnectorManagement,
	method: string,
	name: string | undefined,
	context: ManageContext,
): Promise<Response> {
	if (!name && method === "GET") {
		const list = await guarded(context, "connectors", () => manage.list());
		return json(list.map((c) => connectorView(c)));
	}
	if (!name && method === "POST") {
		const body = await objectBody(context);
		const header = optional(body.header, 100);
		const token = optional(body.token, 4000);
		const input = {
			name: required(body.name, 100),
			url: required(body.url, 2000),
			description: required(body.description, 1000),
			...(header ? { header } : {}),
			...(token ? { token } : {}),
		};
		const added = await guarded(context, "connectors", () => manage.add(input));
		context.changed();
		return json(
			{
				connector: connectorView(added.connector),
				skipped: [...added.skipped],
			} satisfies ConnectorAddedView,
			201,
		);
	}
	if (name && method === "PATCH") {
		const description = required((await objectBody(context)).description, 1000);
		await guarded(context, "connectors", () =>
			manage.describe(name, description),
		);
		context.changed();
		return json({ name });
	}
	if (name && method === "DELETE") {
		await guarded(context, "connectors", () => manage.remove(name));
		context.changed();
		return json({ removed: name });
	}
	throw new HttpError(405, "This method is not supported.");
}

/**
 * `connectors/grants…`: the bundles with their channels (`GET`), the channels to pick (`GET
 * channels`), authorize (`POST`), describe (`PATCH <bundle>/<channel>`), revoke (`DELETE
 * <bundle>/<channel>`) and rotate (`POST <bundle>/rotate`).
 */
export async function grantRoutes(
	grants: McpGrants,
	method: string,
	rest: readonly string[],
	context: ManageContext,
): Promise<Response> {
	const [first, second] = rest;
	if (rest.length === 0 && method === "GET") {
		const bundles = await guarded(context, "grants", () => grants.bundles());
		return json({
			operations: grants.operations.map((o) => ({ id: o.id, label: o.label })),
			bundles: bundles.map((bundle) => ({
				name: bundle.name,
				grants: bundle.grants.map((g) => ({
					channelId: g.channelId,
					guildName: g.guildName,
					channelName: g.channelName,
					visible: g.visible,
					displayName: g.displayName,
					description: g.description,
					operations: [...g.operations],
					authorizedAt: g.authorizedAt.toISOString(),
					audit: g.audit.map((a) => ({
						tool: a.tool,
						status: a.status,
						at: a.createdAt.toISOString(),
					})),
				})),
			})),
		} satisfies McpGrantsView);
	}
	if (rest.length === 1 && first === "channels" && method === "GET") {
		const channels = await guarded(context, "grants", () =>
			grants.channels(context.actor),
		);
		return json(
			channels.map(
				(c): McpChannelView => ({ id: c.id, name: c.name, guild: c.guild }),
			),
		);
	}
	if (rest.length === 0 && method === "POST") {
		const body = await objectBody(context);
		if (
			!Array.isArray(body.operations) ||
			body.operations.some((op) => typeof op !== "string")
		)
			throw new HttpError(400, "The body is not valid.");
		const displayName = optional(body.displayName, 100);
		const description = optional(body.description, 1000);
		const input: McpAuthorizeInput = {
			bundle: required(body.bundle, 200),
			channelId: required(body.channelId, 40),
			operations: body.operations as string[],
			...(displayName ? { displayName } : {}),
			...(description ? { description } : {}),
		};
		const done = await guarded(context, "grants", () =>
			grants.authorize(input, context.actor),
		);
		context.changed();
		return json(
			{
				bundle: done.bundle,
				...(done.url ? { url: done.url } : {}),
			} satisfies McpUrlView,
			201,
		);
	}
	if (rest.length === 2 && first && second === "rotate" && method === "POST") {
		const { url } = await guarded(context, "grants", () =>
			grants.rotate(first),
		);
		context.changed();
		return json({ bundle: first, url } satisfies McpUrlView);
	}
	if (rest.length === 2 && first && second && method === "PATCH") {
		const body = await objectBody(context);
		const displayName = optional(body.displayName, 100);
		const description =
			body.description === undefined
				? undefined
				: required(body.description, 1000);
		await guarded(context, "grants", () =>
			grants.describe(first, second, {
				...(displayName === undefined ? {} : { displayName }),
				...(description === undefined ? {} : { description }),
			}),
		);
		context.changed();
		return json({ bundle: first, channelId: second });
	}
	if (rest.length === 2 && first && second && method === "DELETE") {
		await guarded(context, "grants", () => grants.revoke(first, second));
		context.changed();
		return json({ bundle: first, channelId: second });
	}
	throw new HttpError(405, "This method is not supported.");
}
