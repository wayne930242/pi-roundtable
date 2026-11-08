import { type ConsolePresentation, message } from "../features.ts";
import { json } from "../http.ts";
import { readLimited } from "../request-body.ts";
import { WebhookError, type Webhooks } from "./webhooks.ts";

const PATH = /^api\/agents\/([^/]+)\/webhooks(?:\/([^/]+))?$/;
/** A webhook's settings are a few fields. */
const MAX_BODY_BYTES = 4096;

/**
 * The owner's webhook routes, below the mount: `GET api/agents/:name/webhooks` lists a knight's
 * webhooks, `POST` there makes one and answers its URL this once, and `DELETE
 * api/agents/:name/webhooks/:id` revokes one. The authorization table lets only owners reach
 * them, and `GET api/webhooks`, every knight's, for the Webhooks page. Undefined for any other path.
 */
export async function webhookRoute(
	webhooks: Webhooks,
	request: Request,
	rest: string,
	presentation: ConsolePresentation | undefined,
): Promise<Response | undefined> {
	const bad = (source: string, status: number) =>
		json({ error: message(presentation, source) }, status);
	if (rest === "api/webhooks")
		return request.method === "GET"
			? json({ webhooks: await webhooks.listAll() })
			: bad("Method not allowed.", 405);
	const matched = PATH.exec(rest);
	if (!matched) return undefined;
	let agent: string;
	let id: string | undefined;
	try {
		agent = decodeURIComponent(matched[1] as string);
		id = matched[2] === undefined ? undefined : decodeURIComponent(matched[2]);
	} catch {
		return bad("There is no such knight.", 404);
	}
	if (!webhooks.permanent(agent))
		return bad("Only an active permanent knight has webhooks.", 404);
	if (id !== undefined) {
		if (request.method !== "DELETE") return bad("Method not allowed.", 405);
		return (await webhooks.revoke(agent, id))
			? new Response(null, { status: 204 })
			: bad("There is no such webhook.", 404);
	}
	if (request.method === "GET")
		return json({ webhooks: await webhooks.list(agent) });
	if (request.method !== "POST") return bad("Method not allowed.", 405);
	const raw = await readLimited(request, MAX_BODY_BYTES);
	let body: Record<string, unknown> | undefined;
	try {
		const parsed: unknown = raw ? JSON.parse(raw.toString("utf8")) : undefined;
		if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed))
			body = parsed as Record<string, unknown>;
	} catch {
		// Refused below, as any body that is not an object.
	}
	if (!body) return bad("The request body is not valid.", 400);
	try {
		const created = await webhooks.create(
			agent,
			{
				name: body.name,
				expiresInMinutes: body.expiresInMinutes,
				once: body.once,
			},
			"owner",
		);
		return json(created, 201);
	} catch (error) {
		if (error instanceof WebhookError)
			return json(
				{ error: message(presentation, error.message) },
				error.status,
			);
		throw error;
	}
}
