import { join } from "node:path";
import type {
	AgentTeam,
	ChannelKey,
	Logger,
	MemoryKind,
	QueuePort,
	SpeakerMemory,
} from "pi-roundtable";
import { MemoryError } from "pi-roundtable";
import { thinkingLabel } from "pi-roundtable/kit";
import type {
	ApiError,
	ChannelName,
	ConfigView,
	ConversationKind,
	ConversationsView,
	ConversationView,
	NoteInput,
	NoteView,
	OverviewView,
	PaneName,
	TranscriptView,
} from "./api-types.ts";
import {
	archiveNames,
	conversationFiles,
	parseKey,
	readTranscript,
	type StoredConversation,
	storedConversations,
} from "./conversations.ts";

const NOTE_SEARCH_LIMIT = 500;
/** The largest note body the console reads. */
const MAX_BODY_BYTES = 64 * 1024;

export interface ConsolePorts {
	title: string;
	timeZone: string;
	panes: readonly PaneName[];
	/** The host's `sessions/` directory. */
	sessionsDir: string;
	/** Present when the overview pane is served, or the agent server is there to classify channels. */
	team?: Pick<AgentTeam, "status" | "owns" | "guildId">;
	queue: Pick<QueuePort, "size">;
	/** Undefined when Discord no longer knows the channel; throws when it cannot be asked. */
	channelName?: (channelId: string) => Promise<ChannelName | undefined>;
	/** The owner's memory; present when the notes pane is served. */
	memory?: Pick<
		SpeakerMemory,
		"list" | "search" | "add" | "update" | "removeById"
	>;
	/** Conversations the console must not list or read. */
	exclude?: (key: ChannelKey) => boolean;
	/** Text a relayed message begins with, which is not the owner's words. */
	relayNotes: readonly string[];
	/** Called after a note is written, so every open page refreshes. */
	changed(): void;
	logger: Logger;
}

class HttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

const json = (body: unknown, status = 200) =>
	Response.json(body, {
		status,
		headers: { "cache-control": "no-store" },
	});

/** Memory refusals as the Notes pane shows them. */
const MEMORY_REASONS: Record<string, string> = {
	"a memory fact cannot be empty": "The note cannot be empty.",
	"an event needs its date as YYYY-MM-DD":
		"An event needs its date as YYYY-MM-DD.",
	"only an event has a date": "Only an event has a date.",
};

const memoryReason = (error: MemoryError): string =>
	MEMORY_REASONS[error.message] ?? "The kind is not one of core, note, event.";

const iso = (date: Date | undefined) => date?.toISOString();

/**
 * The console's JSON API under `<mount>/api/`. Every handler answers JSON; errors never repeat
 * the request URL or headers.
 */
export class ConsoleApi {
	readonly #ports: ConsolePorts;

	constructor(ports: ConsolePorts) {
		this.#ports = ports;
	}

	/** `path` is what follows `<mount>/api/`. */
	async handle(request: Request, path: string): Promise<Response> {
		try {
			return await this.#route(request, path);
		} catch (error) {
			if (error instanceof HttpError)
				return json({ error: error.message } satisfies ApiError, error.status);
			if (error instanceof MemoryError)
				return json({ error: memoryReason(error) } satisfies ApiError, 400);
			// The URL stays out of the log: a path may hold something private.
			this.#ports.logger.error({ err: error }, "console api failed");
			return json(
				{
					error: "The console could not complete the request.",
				} satisfies ApiError,
				500,
			);
		}
	}

	#pane(name: PaneName): void {
		if (!this.#ports.panes.includes(name))
			throw new HttpError(404, "This pane is not served.");
	}

	async #route(request: Request, path: string): Promise<Response> {
		const method = request.method;
		let parts: string[];
		try {
			parts = path.split("/").filter(Boolean).map(decodeURIComponent);
		} catch {
			throw new HttpError(400, "The path is not valid.");
		}
		const [head, id] = parts;
		if (method === "GET" && head === "config" && !id)
			return json(this.config());
		if (method === "GET" && head === "overview" && !id) {
			this.#pane("overview");
			return json(await this.overview());
		}
		if (method === "GET" && head === "conversations" && parts.length <= 2) {
			this.#pane("conversations");
			if (!id) return json(await this.conversations());
			const archive = new URL(request.url).searchParams.get("archive");
			return json(await this.transcript(id, archive ?? undefined));
		}
		if (head === "notes" && parts.length <= 2) {
			this.#pane("notes");
			return this.#notes(request, id);
		}
		throw new HttpError(404, "There is no such API.");
	}

	config(): ConfigView {
		const { title, panes, timeZone } = this.#ports;
		return { title, panes: [...panes], timeZone };
	}

	// ── Overview ───────────────────────────────────────────────────────────

	async overview(): Promise<OverviewView> {
		const { team } = this.#ports;
		if (!team) throw new HttpError(404, "This pane is not served.");
		const status = await team.status();
		return {
			guildId: team.guildId,
			agents: status.agents.map((agent) => ({
				name: agent.name,
				displayName: agent.displayName,
				...(agent.channelId ? { channelId: agent.channelId } : {}),
				model: agent.model,
				thinking: thinkingLabel(agent.thinking),
				...(agent.workingIn ? { workingIn: agent.workingIn } : {}),
				waiting: agent.waiting,
				...(agent.context ? { context: agent.context } : {}),
				...(agent.lastActive ? { lastActive: iso(agent.lastActive) } : {}),
				schedules: agent.schedules,
			})),
			groups: status.groups.map((group) => ({
				name: group.name,
				displayName: group.displayName,
				channelId: group.channelId,
				members: group.members,
				host: group.host,
				busy: group.busy,
				...(group.lastActive ? { lastActive: iso(group.lastActive) } : {}),
			})),
		};
	}

	// ── Conversations ──────────────────────────────────────────────────────

	async conversations(): Promise<ConversationsView> {
		const { sessionsDir, relayNotes, exclude } = this.#ports;
		const stored = storedConversations(sessionsDir, {
			excluded: (key) => exclude?.(key) ?? false,
			relayNotes,
		});
		return {
			conversations: await Promise.all(stored.map((c) => this.#view(c))),
		};
	}

	async transcript(
		key: string,
		archive: string | undefined,
	): Promise<TranscriptView> {
		const { sessionsDir, relayNotes, exclude } = this.#ports;
		const parsed = parseKey(key);
		if (!parsed || exclude?.(key as ChannelKey))
			throw new HttpError(404, "There is no such conversation.");
		const dir = join(sessionsDir, parsed.dir);
		const files = conversationFiles(dir);
		if (!files) throw new HttpError(404, "There is no such conversation.");
		const archives = archiveNames(dir);
		// The archive is chosen from the folder's listing, never joined from the request.
		if (archive !== undefined && !archives.includes(archive))
			throw new HttpError(404, "There is no such archive.");
		const { entries, truncated } = readTranscript(dir, archive, relayNotes);
		return {
			conversation: await this.#view({
				key: key as ChannelKey,
				kind: parsed.kind,
				id: parsed.id,
				...files,
			}),
			archives,
			...(archive !== undefined ? { archive } : {}),
			entries,
			truncated,
		};
	}

	async #view(stored: StoredConversation): Promise<ConversationView> {
		const { team, queue } = this.#ports;
		const owner = team?.owns(stored.key);
		const kind: ConversationKind =
			stored.kind === "mcp" ? "outside" : (owner ?? "owner");
		return {
			key: stored.key,
			kind,
			id: stored.id,
			...(stored.kind === "discord"
				? { channel: await this.#name(stored.id) }
				: {}),
			liveBytes: stored.liveBytes,
			archives: stored.archives,
			...(stored.lastActive ? { lastActive: stored.lastActive } : {}),
			...(stored.firstMessage ? { firstMessage: stored.firstMessage } : {}),
			...(stored.startedAt ? { startedAt: stored.startedAt } : {}),
			busy: queue.size(stored.key),
		};
	}

	async #name(channelId: string): Promise<ChannelName> {
		const lookup = this.#ports.channelName;
		if (!lookup) return { kind: "unknown" };
		try {
			return (await lookup(channelId)) ?? { kind: "gone" };
		} catch {
			// Discord is reconnecting; the id is all the page can show until the next refresh.
			return { kind: "unknown" };
		}
	}

	// ── Notes ──────────────────────────────────────────────────────────────

	async #notes(request: Request, id: string | undefined): Promise<Response> {
		const { memory } = this.#ports;
		if (!memory) throw new HttpError(404, "This pane is not served.");
		const method = request.method;
		if (!id) {
			if (method === "GET") {
				const query = new URL(request.url).searchParams.get("q")?.trim();
				const notes: NoteView[] = query
					? await memory.search(query, NOTE_SEARCH_LIMIT)
					: await memory.list();
				return json(notes);
			}
			if (method === "POST") {
				const input = await noteInput(request);
				const added = await memory.add(input.fact, input.kind, input.eventDate);
				this.#ports.changed();
				return json(added, 201);
			}
		} else {
			const noteId = Number(id);
			if (!Number.isSafeInteger(noteId))
				throw new HttpError(404, "There is no such note.");
			if (method === "PATCH") {
				const updated = await memory.update(noteId, await noteInput(request));
				if (!updated) throw new HttpError(404, "There is no such note.");
				this.#ports.changed();
				return json(updated);
			}
			if (method === "DELETE") {
				if (!(await memory.removeById(noteId)))
					throw new HttpError(404, "There is no such note.");
				this.#ports.changed();
				return json({ deleted: noteId });
			}
		}
		throw new HttpError(405, "This method is not supported.");
	}
}

async function readBody(request: Request): Promise<unknown> {
	const declared = Number(request.headers.get("content-length") ?? 0);
	if (declared > MAX_BODY_BYTES)
		throw new HttpError(413, "The request is too large.");
	const text = await request.text();
	if (Buffer.byteLength(text) > MAX_BODY_BYTES)
		throw new HttpError(413, "The request is too large.");
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

async function noteInput(request: Request): Promise<{
	fact: string;
	kind: MemoryKind;
	eventDate?: string;
}> {
	const body = await readBody(request);
	if (typeof body !== "object" || body === null)
		throw new HttpError(400, "The body is not valid.");
	const { fact, kind, eventDate } = body as Partial<NoteInput>;
	if (typeof fact !== "string" || typeof kind !== "string")
		throw new HttpError(400, "The body is not valid.");
	if (eventDate !== undefined && typeof eventDate !== "string")
		throw new HttpError(400, "The date is not valid.");
	return {
		fact,
		kind: kind as MemoryKind,
		...(eventDate ? { eventDate } : {}),
	};
}
