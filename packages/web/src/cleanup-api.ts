import { join } from "node:path";
import type { AgentTeam, ChannelKey } from "pi-roundtable";
import { conversationFiles, parseKey } from "./conversations.ts";
import type { ConsoleFeatures } from "./features.ts";
import { ConsoleHttpError as HttpError, json } from "./http.ts";

interface CleanupPorts {
	features?: ConsoleFeatures;
	exclude?: (key: ChannelKey) => boolean;
	team?: Pick<AgentTeam, "owns" | "status">;
	sessionsDir: string;
	changed(): void;
}

/** The console validates ownership before invoking destructive host operations. */
export async function cleanupConversation(
	ports: CleanupPorts,
	raw: string,
	action: "start-over" | "delete",
): Promise<Response> {
	const { features, exclude, team, sessionsDir } = ports;
	const cleanup = features?.cleanup;
	const key = raw as ChannelKey;
	const parsed = parseKey(raw);
	if (!cleanup || !parsed || parsed.kind === "group" || exclude?.(key))
		throw new HttpError(404, "There is no such conversation.");
	const owned =
		Boolean(team?.owns(key)) || Boolean(features?.party?.contains(key));
	const group =
		(await team?.status())?.groups.some(
			(g) => `discord:${g.channelId}` === key,
		) ?? false;
	const stored =
		!owned &&
		!group &&
		Boolean(conversationFiles(join(sessionsDir, parsed.dir)));
	if (action === "delete") {
		if (!stored)
			throw new HttpError(
				404,
				"Only workspace and outside conversations can be deleted.",
			);
		const result = await cleanup.deleteConversation(key);
		if (result === "busy")
			throw new HttpError(409, "The conversation is busy. Try again later.");
		ports.changed();
		return json({ result });
	}
	if (!owned && !group && !stored)
		throw new HttpError(404, "There is no such conversation.");
	const kind = await cleanup.startFresh(key);
	ports.changed();
	return json({ kind });
}
