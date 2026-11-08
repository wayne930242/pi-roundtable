import type { SQL } from "bun";
import type { AgentDirectory, Logger } from "pi-roundtable";
import type { AppSurface } from "../app/surface.ts";
import type { ConsolePresentation } from "../features.ts";
import { webhookRoute } from "./owner-routes.ts";
import { WebhookStore } from "./store.ts";
import type { WebhooksSlot } from "./tools.ts";
import { Webhooks } from "./webhooks.ts";

/** What the console server asks of the webhooks: the open post path, and the owner's routes. */
export interface WebhookRoutes {
	/** Answers `hooks/…` below the mount, before any session is asked for. */
	post(request: Request, rest: string): Promise<Response>;
	/** Answers the owner's `api/agents/:name/webhooks…` routes; undefined for any other path. */
	route(request: Request, rest: string): Promise<Response | undefined>;
}

/** Makes the webhooks of the app's agent rooms, and hands them to the agents' tools through `slot`. */
export function mountWebhooks(parts: {
	database: SQL;
	directory: Pick<AgentDirectory, "agent">;
	surface: AppSurface;
	/** The public origin a webhook's URL starts with, and the console's mount. */
	origin: string;
	mount: string;
	presentation?: ConsolePresentation;
	slot: WebhooksSlot;
	logger: Logger;
}): WebhookRoutes {
	const webhooks = new Webhooks({
		store: new WebhookStore(parts.database),
		directory: parts.directory,
		surface: parts.surface,
		surfaceName: parts.surface.surface,
		base: `${parts.origin}${parts.mount}`,
		logger: parts.logger,
	});
	parts.slot.current = webhooks;
	return {
		post: (request, rest) => webhooks.post(request, rest),
		route: (request, rest) =>
			webhookRoute(webhooks, request, rest, parts.presentation),
	};
}
