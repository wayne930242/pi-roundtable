import { join } from "node:path";
import type {
	AgentTeam,
	ChannelKey,
	ConversationRecord,
	ConversationRegistry,
	IdentityService,
	Logger,
	MemoryKind,
	QueuePort,
	SpeakerMemory,
} from "pi-roundtable";
import { MemoryError, parseChannelKey, SYSTEM_PRINCIPAL } from "pi-roundtable";
import { thinkingLabel } from "pi-roundtable/kit";
import type {
	ApiError,
	ChannelName,
	ConfigView,
	ConversationKind,
	ConversationsView,
	ConversationView,
	DashboardView,
	NoteInput,
	NoteView,
	OverviewView,
	PaneName,
	PrincipalName,
	PrincipalsView,
	TranscriptView,
} from "./api-types.ts";
import {
	archiveNames,
	conversationFiles,
	parseKey,
	readTranscript,
	registeredConversations,
	registeredDir,
	type StoredConversation,
	type StoredKind,
	storedConversations,
} from "./conversations.ts";
import {
	type ConsoleFeatures,
	type ConsolePresentation,
	message,
	safeAdminUrl,
} from "./features.ts";
import type { Visitor } from "./visitors.ts";

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
	/** A principal's memory; present when the notes pane is served. */
	memoryOf?: (
		principalId: string,
	) => Pick<SpeakerMemory, "list" | "search" | "add" | "update" | "removeById">;
	/** The host's principals, read only: whose notes the pane may show, and the names of conversations' principals. */
	people?: Pick<IdentityService, "principal" | "list">;
	/** Conversations the console must not list or read. */
	exclude?: (key: ChannelKey) => boolean;
	/** The host's conversation registry; without it only the conversations found by name are listed. */
	registry?: Pick<ConversationRegistry, "list" | "get">;
	/** Text a relayed message begins with, which is not the owner's words. */
	relayNotes: readonly string[];
	/** Called after a note is written, so every open page refreshes. */
	changed(): void;
	logger: Logger;
	features?: ConsoleFeatures;
	presentation?: ConsolePresentation;
	mountPath?: string;
}

import { cleanupConversation } from "./cleanup-api.ts";
import { connectorsView } from "./connectors-api.ts";
import { ConsoleHttpError as HttpError, json } from "./http.ts";
import { skillCatalog, skillDetail } from "./skills-api.ts";

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

	/** `path` is what follows `<mount>/api/`; `visitor` is the owner the request comes from. */
	async handle(
		request: Request,
		path: string,
		visitor: Visitor,
	): Promise<Response> {
		try {
			return await this.#route(request, path, visitor);
		} catch (error) {
			if (error instanceof HttpError)
				return json(
					{
						error: `${message(this.#ports.presentation, error.message)}${error.detail ?? ""}`,
					} satisfies ApiError,
					error.status,
				);
			if (error instanceof MemoryError)
				return json(
					{
						error: message(this.#ports.presentation, memoryReason(error)),
					} satisfies ApiError,
					400,
				);
			// The URL stays out of the log: a path may hold something private.
			this.#ports.logger.error({ err: error }, "console api failed");
			return json(
				{
					error: message(
						this.#ports.presentation,
						"The console could not complete the request.",
					),
				} satisfies ApiError,
				500,
			);
		}
	}

	#pane(name: PaneName): void {
		if (!this.#ports.panes.includes(name))
			throw new HttpError(404, "This pane is not served.");
	}

	async #route(
		request: Request,
		path: string,
		visitor: Visitor,
	): Promise<Response> {
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
		if (
			method === "GET" &&
			(head === "overview" || head === "dashboard") &&
			!id
		) {
			this.#pane("overview");
			const view = await this.overview();
			if (head === "overview") return json(view);
			return json({
				agentGuildId: view.guildId,
				agents: view.agents.map((agent) => ({
					...agent,
					key: agent.channelId ? `discord:${agent.channelId}` : "",
				})),
				groups: view.groups.map((group) => ({
					...group,
					key: `discord:${group.channelId}`,
				})),
				workspaces: (view.workspaces ?? []).map((c) => ({
					...c,
					channelId: c.id,
				})),
				outside: (view.outside ?? []).map((c) => ({ ...c, sessionId: c.id })),
				party: view.party ?? [],
			} satisfies DashboardView);
		}
		if (method === "GET" && head === "conversations" && parts.length <= 2) {
			this.#pane("conversations");
			if (!id) return json(await this.conversations());
			const archive = new URL(request.url).searchParams.get("archive");
			return json(await this.transcript(id, archive ?? undefined));
		}
		if (method === "POST" && head === "channels" && id && parts.length === 3) {
			this.#pane("overview");
			if (parts[2] === "start-over" || parts[2] === "delete")
				return cleanupConversation(this.#ports, id, parts[2]);
		}
		if (method === "GET" && head === "skills" && parts.length <= 2) {
			this.#pane("skills");
			const skills = this.#ports.features?.skills;
			if (!skills) throw new HttpError(404, "This pane is not served.");
			return json(id ? await skillDetail(skills, id) : skillCatalog(skills));
		}
		if (method === "GET" && head === "connectors" && parts.length === 1) {
			this.#pane("connectors");
			const connectors = this.#ports.features?.connectors;
			if (!connectors) throw new HttpError(404, "This pane is not served.");
			return json(await connectorsView(connectors));
		}
		if (head === "notes" && parts.length <= 2) {
			this.#pane("notes");
			return this.#notes(request, id, visitor);
		}
		if (method === "GET" && head === "principals" && !id) {
			this.#pane("notes");
			return json(await this.principals(visitor));
		}
		throw new HttpError(404, "There is no such API.");
	}

	config(): ConfigView {
		const { title, panes, timeZone } = this.#ports;
		const { presentation, features } = this.#ports;
		const connectorAdminUrl = safeAdminUrl(features?.connectors?.adminUrl);
		return {
			title,
			panes: [...panes],
			timeZone,
			...(presentation?.locale ? { locale: presentation.locale } : {}),
			...(presentation?.messages ? { messages: presentation.messages } : {}),
			...(features?.cleanup ? { cleanup: true } : {}),
			...(connectorAdminUrl ? { connectorAdminUrl } : {}),
			...(this.#ports.mountPath ? { mountPath: this.#ports.mountPath } : {}),
		};
	}

	// ── Overview ───────────────────────────────────────────────────────────

	async overview(): Promise<OverviewView> {
		const { team } = this.#ports;
		if (!team) throw new HttpError(404, "This pane is not served.");
		const status = await team.status();
		const { features } = this.#ports;
		const stored = (await this.conversations()).conversations.filter(
			(c) => c.kind === "owner" || c.kind === "outside",
		);
		const workspaces = await Promise.all(
			stored
				.filter((c) => c.kind === "owner")
				.map(async (c) => ({
					...c,
					schedules:
						(await features?.schedules?.count(c.key as ChannelKey)) ?? 0,
				})),
		);
		return {
			workspaces,
			outside: stored.filter((c) => c.kind === "outside"),
			party: (await features?.party?.list()) ?? [],
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
		const { sessionsDir, relayNotes, registry } = this.#ports;
		const filter = {
			excluded: (key: ChannelKey) => this.#hidden(key),
			relayNotes,
		};
		const records = registry ? await registry.list() : [];
		// The registry first; the directory scan reads the conversations from before it, by name.
		const recorded = registeredConversations(sessionsDir, records, filter);
		const stored = [
			...recorded,
			...storedConversations(sessionsDir, filter),
		].sort((a, b) => (b.lastActive ?? "").localeCompare(a.lastActive ?? ""));
		const byKey = new Map(records.map((record) => [record.key, record]));
		const names = new Map<string, Promise<PrincipalName>>();
		return {
			conversations: await Promise.all(
				stored.map((c) => this.#view(c, byKey.get(c.key), names)),
			),
		};
	}

	#hidden(key: ChannelKey): boolean {
		return (
			(this.#ports.exclude?.(key) ?? false) ||
			(this.#ports.features?.party?.contains(key) ?? false)
		);
	}

	/** The session directory and identity of a conversation the console may read, or undefined. */
	async #located(
		key: string,
	): Promise<
		{ dir: string; kind: StoredKind; id: string; member?: string } | undefined
	> {
		const parsed = parseKey(key);
		if (parsed) return parsed;
		const record = await this.#ports.registry?.get(key as ChannelKey);
		return record
			? {
					dir: registeredDir(record.key),
					kind: "registered",
					id: parseChannelKey(record.key).id,
				}
			: undefined;
	}

	async transcript(
		key: string,
		archive: string | undefined,
	): Promise<TranscriptView> {
		const { sessionsDir, relayNotes } = this.#ports;
		const parsed = await this.#located(key);
		if (!parsed || this.#hidden(key as ChannelKey))
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
			conversation: await this.#view(
				{
					key: key as ChannelKey,
					kind: parsed.kind,
					id: parsed.id,
					...(parsed.member ? { member: parsed.member } : {}),
					...files,
				},
				await this.#ports.registry?.get(key as ChannelKey),
			),
			archives,
			...(archive !== undefined ? { archive } : {}),
			entries,
			truncated,
		};
	}

	/**
	 * How the page shows a conversation. `record` is what the registry holds of it, which says whose
	 * it is; `names` gathers the principals' names one listing reads, so each is read once.
	 */
	async #view(
		stored: StoredConversation,
		record: ConversationRecord | undefined,
		names = new Map<string, Promise<PrincipalName>>(),
	): Promise<ConversationView> {
		const { team, queue } = this.#ports;
		const owner = record?.principalId;
		let principal: Promise<PrincipalName> | undefined;
		if (owner !== undefined) {
			principal = names.get(owner) ?? this.#principalName(owner);
			names.set(owner, principal);
		}
		const kind: ConversationKind =
			stored.kind === "mcp"
				? "outside"
				: stored.kind === "registered"
					? "plugin"
					: stored.kind === "group"
						? "group"
						: (team?.owns(stored.key) ?? "owner");
		return {
			key: stored.key,
			kind,
			id: stored.id,
			...(stored.member ? { member: stored.member } : {}),
			...(stored.kind === "mcp" || stored.kind === "registered"
				? {}
				: { channel: await this.#name(stored.id) }),
			...(stored.title === undefined ? {} : { title: stored.title }),
			liveBytes: stored.liveBytes,
			archives: stored.archives,
			...(stored.lastActive ? { lastActive: stored.lastActive } : {}),
			...(stored.firstMessage ? { firstMessage: stored.firstMessage } : {}),
			...(stored.startedAt ? { startedAt: stored.startedAt } : {}),
			...(record ? { visibility: record.visibility } : {}),
			...(principal ? { principal: await principal } : {}),
			// A group's turns queue under the group channel, not under each member's conversation.
			busy: queue.size(
				stored.kind === "group" ? `discord:${stored.id}` : stored.key,
			),
		};
	}

	async #principalName(id: string): Promise<PrincipalName> {
		const known = await this.#ports.people?.principal(id);
		return { id, name: known?.displayName ?? id };
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

	/** The people whose notes the pane can show: every principal but the host's own, the visitor first. */
	async principals(visitor: Visitor): Promise<PrincipalsView> {
		const self = visitor.principal.id;
		const everyone = (await this.#ports.people?.list()) ?? [visitor.principal];
		const listed = [
			...everyone.filter((p) => p.id === self),
			...everyone.filter((p) => p.id !== self && p.id !== SYSTEM_PRINCIPAL),
		];
		return {
			self,
			principals: listed.map((p) => ({
				id: p.id,
				name: p.displayName,
				...(p.disabled ? { disabled: true as const } : {}),
			})),
		};
	}

	/** The memory of the principal the request names, default the visitor's own. */
	async #memoryFor(request: Request, visitor: Visitor) {
		const { memoryOf, people } = this.#ports;
		if (!memoryOf) throw new HttpError(404, "This pane is not served.");
		const named = new URL(request.url).searchParams.get("principal");
		if (named === null || named === visitor.principal.id)
			return memoryOf(visitor.principal.id);
		// The host's own principal keeps no notes; anyone else must be a principal the host knows.
		if (named === SYSTEM_PRINCIPAL || !(await people?.principal(named)))
			throw new HttpError(404, "There is no such person.");
		return memoryOf(named);
	}

	async #notes(
		request: Request,
		id: string | undefined,
		visitor: Visitor,
	): Promise<Response> {
		const memory = await this.#memoryFor(request, visitor);
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

/** The JSON body, read in chunks so a body past the limit is refused without being held whole. */
async function readBody(request: Request): Promise<unknown> {
	const tooLarge = () => new HttpError(413, "The request is too large.");
	if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES)
		throw tooLarge();
	const chunks: Uint8Array[] = [];
	let size = 0;
	if (request.body)
		for await (const chunk of request.body) {
			size += chunk.byteLength;
			if (size > MAX_BODY_BYTES) throw tooLarge();
			chunks.push(chunk);
		}
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
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
