import { rmSync } from "node:fs";
import type { Server, WebSocketHandler } from "bun";

/**
 * Serves HTTP on a unix socket without Bun's 10-second idle timeout, which would cut long
 * turns and quiet model streams. Bun 1.4.2 honors `idleTimeout` on unix sockets, but its
 * types reject the option there, hence the cast. A stale socket file is removed first.
 * `error` answers a failure raised outside the fetch handler; without it Bun's own page is sent.
 */
export function serveUnix(
	socketPath: string,
	fetch: (
		request: Request,
		server: Server<undefined>,
	) => Response | Promise<Response>,
	options?: { error?: (error: Error) => Response | Promise<Response> },
): Server<undefined>;
/**
 * Serves HTTP and WebSockets on a unix socket: `websocket` serves the sockets `fetch` upgrades
 * with `server.upgrade`, and `fetch` answers nothing for a request it upgraded.
 */
export function serveUnix<WebSocketData>(
	socketPath: string,
	fetch: (
		request: Request,
		server: Server<WebSocketData>,
	) => Response | undefined | Promise<Response | undefined>,
	options: {
		error?: (error: Error) => Response | Promise<Response>;
		websocket: WebSocketHandler<WebSocketData>;
	},
): Server<WebSocketData>;
export function serveUnix<WebSocketData>(
	socketPath: string,
	fetch: (
		request: Request,
		server: Server<WebSocketData>,
	) => Response | undefined | Promise<Response | undefined>,
	options: {
		error?: (error: Error) => Response | Promise<Response>;
		websocket?: WebSocketHandler<WebSocketData>;
	} = {},
): Server<WebSocketData> {
	rmSync(socketPath, { force: true });
	const serveOptions = {
		unix: socketPath,
		idleTimeout: 0,
		fetch,
		...(options.error ? { error: options.error } : {}),
		...(options.websocket ? { websocket: options.websocket } : {}),
	};
	// SAFETY: these are Bun's unix-socket options; only `idleTimeout` is missing from its types.
	return Bun.serve(
		serveOptions as unknown as Parameters<typeof Bun.serve>[0],
	) as unknown as Server<WebSocketData>;
}
