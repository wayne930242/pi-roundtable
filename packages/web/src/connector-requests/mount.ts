import type { SQL } from "bun";
import type { Logger, Services } from "pi-roundtable";
import type { ConnectorManagement } from "../features.ts";
import {
	CONNECTOR_ADD_REQUESTS,
	ConnectorAddRequests,
	type FollowUpSurface,
} from "./requests.ts";
import { ConnectorAddRequestStore } from "./store.ts";

/** Makes the connector add requests of a console with the app, and provides them to pi-roundtable-mcp's `connector_add`. */
export function mountConnectorRequests(parts: {
	database: SQL;
	services: Pick<Services, "provide">;
	manage: ConnectorManagement | undefined;
	surface: () => FollowUpSurface | undefined;
	surfaceName: string;
	/** The page's origin and mount, and whether it routes by path or by hash. */
	origin: string;
	mount: string;
	routing: "path" | "hash";
	logger: Logger;
}): ConnectorAddRequests {
	const requests = new ConnectorAddRequests({
		store: new ConnectorAddRequestStore(parts.database),
		manage: parts.manage,
		surface: parts.surface,
		surfaceName: parts.surfaceName,
		link: (id) =>
			`${parts.origin}${parts.mount}/${parts.routing === "path" ? "" : "#/"}connectors?add=${encodeURIComponent(id)}`,
		logger: parts.logger,
	});
	parts.services.provide(CONNECTOR_ADD_REQUESTS, {
		minutes: requests.minutes,
		create: (request) => requests.create(request),
	});
	return requests;
}
