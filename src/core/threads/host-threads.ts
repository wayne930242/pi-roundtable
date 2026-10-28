import { parseChannelKey, type SurfaceThreads } from "../contract/surface.ts";
import type { ThreadHost } from "./dispatch-threads.ts";

/**
 * A Discord `ThreadHost` as the `SurfaceThreads` of the `discord` surface: a thread's id is its
 * Discord channel id, mentioned as `<#id>`, and a parent is the Discord channel behind its key.
 */
export function threadsOfHost(host: ThreadHost): SurfaceThreads {
	const send = host.send?.bind(host);
	return {
		open: async (parent, name, line) => {
			const id = await host.open(parseChannelKey(parent).id, name, line);
			return id ? { id, mention: `<#${id}>` } : undefined;
		},
		post: (thread, text) => host.post(thread, text),
		...(send ? { send } : {}),
		close: (thread) => host.close(thread),
	};
}
