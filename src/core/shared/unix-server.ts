import { rmSync } from "node:fs";
import type { Server } from "bun";

/**
 * Serves HTTP on a unix socket without Bun's 10-second idle timeout, which would cut long
 * turns and quiet model streams. Bun 1.4.2 honors `idleTimeout` on unix sockets, but its
 * types reject the option there, hence the cast. A stale socket file is removed first.
 */
export function serveUnix(
	socketPath: string,
	fetch: (request: Request) => Response | Promise<Response>,
): Server<undefined> {
	rmSync(socketPath, { force: true });
	const options = { unix: socketPath, idleTimeout: 0, fetch };
	return Bun.serve(
		options as unknown as Parameters<typeof Bun.serve>[0],
	) as Server<undefined>;
}
