import type { VirtualServer } from "pi-roundtable/kit";
import { ConnectorError } from "./connector-results.ts";
import {
	ContextForgeError,
	type GatewayTool,
	VirtualServerRequestError,
} from "./contextforge.ts";
import type { ConnectorMessages } from "./messages.ts";

/**
 * The pause between a resync's admin requests: 50 a minute. ContextForge allows 100 a minute, and
 * going over locks the admin account, which every MCP call of the host uses, for 15 minutes.
 */
export const DEFAULT_RESYNC_INTERVAL_MS = 1200;
/** How long resyncs are refused after the gateway refused the admin account: the lock lasts 15 minutes. */
export const DEFAULT_RESYNC_LOCKOUT_MS = 15 * 60_000;

/** Statuses of a rate limit (429) or of a locked or refused admin account (401, 403, 423). */
const LOCKOUT_STATUSES = [429, 401, 403, 423];

/** Whether the gateway refused the admin account, so that asking again only prolongs it. */
export function isLockout(error: unknown): boolean {
	return (
		(error instanceof ContextForgeError ||
			error instanceof VirtualServerRequestError) &&
		error.status !== undefined &&
		LOCKOUT_STATUSES.includes(error.status)
	);
}

/** Paces the admin requests of resyncs, and refuses them for a while once the gateway refused the account. */
export class ResyncGate {
	readonly #interval: number;
	readonly #lockout: number;
	#nextRequestAt = 0;
	#lockedUntil = 0;

	constructor(
		interval = DEFAULT_RESYNC_INTERVAL_MS,
		lockout = DEFAULT_RESYNC_LOCKOUT_MS,
	) {
		this.#interval = interval;
		this.#lockout = lockout;
	}

	/** Waits until the requests before this one are an interval apart from it; it then takes `requests` slots. */
	async pace(requests: number): Promise<void> {
		const wait = this.#nextRequestAt - Date.now();
		if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
		this.#nextRequestAt = Date.now() + requests * this.#interval;
	}

	/** Refuses every resync for the lockout time, whether or not an earlier one already did. */
	lock(): void {
		this.#lockedUntil = Date.now() + this.#lockout;
	}

	get locked(): boolean {
		return Date.now() < this.#lockedUntil;
	}
}

const canonical = (server: VirtualServer): string =>
	JSON.stringify([
		[...server.tools].sort(),
		Object.entries(server.hints ?? {}).sort(([a], [b]) => a.localeCompare(b)),
	]);

/** Whether two readings of a virtual server hold the same tools with the same hints. */
export function sameServer(a: VirtualServer, b: VirtualServer): boolean {
	return canonical(a) === canonical(b);
}

/**
 * What a virtual server may serve while the gateway changes its tools: the tools it served and the
 * ones about to be attached, with the hints of both and the new ones winning. A tool a host's hold
 * rule does not find on a server runs unasked, so the cache must list a new name before the gateway
 * serves it.
 */
export function provisionalServer(
	before: VirtualServer,
	usable: readonly GatewayTool[],
): VirtualServer {
	const hints = {
		...before.hints,
		...Object.fromEntries(
			usable.flatMap((tool) => (tool.hints ? [[tool.name, tool.hints]] : [])),
		),
	};
	return {
		...before,
		tools: [
			...before.tools,
			...usable
				.map((tool) => tool.name)
				.filter((tool) => !before.tools.includes(tool)),
		],
		...(Object.keys(hints).length > 0 ? { hints } : {}),
	};
}

/** A gateway's tools that fit the name limit and those left out; a gateway with none to offer is refused. */
export function usableTools(
	tools: GatewayTool[],
	max: number,
	text: ConnectorMessages,
): { usable: GatewayTool[]; skipped: string[] } {
	const usable = tools.filter((tool) => tool.name.length <= max);
	const skipped = tools
		.filter((tool) => tool.name.length > max)
		.map((tool) => tool.name);
	if (usable.length === 0)
		throw new ConnectorError(
			tools.length === 0 ? text.noTools : text.toolsTooLong(max, skipped),
		);
	return { usable, skipped };
}
