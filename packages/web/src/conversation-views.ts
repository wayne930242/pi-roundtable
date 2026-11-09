import { join } from "node:path";
import type { ChannelKey, ConversationRecord } from "pi-roundtable";
import { parseChannelKey } from "pi-roundtable";
import type {
	ChannelName,
	ConversationKind,
	ConversationsView,
	ConversationView,
	PrincipalName,
	TranscriptView,
} from "./api-types.ts";
import type { ConsolePorts } from "./console-ports.ts";
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
import { ConsoleHttpError as HttpError } from "./http.ts";
import type { Visitor } from "./visitors.ts";

/** The conversations the console lists and reads: found on disk and in the registry, named for the page. */
export class ConversationViews {
	readonly #ports: ConsolePorts;

	constructor(ports: ConsolePorts) {
		this.#ports = ports;
	}

	async conversations(visitor?: Visitor): Promise<ConversationsView> {
		const { sessionsDir, relayNotes, registry } = this.#ports;
		const owner = visitor === undefined || visitor.tier === "owner";
		// A visitor who is not an owner reads their own private conversations, found by the registry alone.
		const records = registry
			? await registry.list(
					owner ? undefined : { principal: visitor.principal.id },
				)
			: [];
		const byKey = new Map(records.map((record) => [record.key, record]));
		const filter = {
			excluded: (key: ChannelKey) => this.#hidden(key, byKey.get(key)),
			relayNotes,
		};
		const mine = owner
			? records
			: records.filter(
					(record) =>
						record.visibility === "private" &&
						record.principalId === visitor.principal.id,
				);
		// The registry first; the directory scan reads the conversations from before it, by name.
		const recorded = registeredConversations(sessionsDir, mine, filter);
		const stored = [
			...recorded,
			...(owner ? storedConversations(sessionsDir, filter) : []),
		].sort((a, b) => (b.lastActive ?? "").localeCompare(a.lastActive ?? ""));
		const names = new Map<string, Promise<PrincipalName>>();
		return {
			conversations: await Promise.all(
				stored.map((c) => this.#view(c, byKey.get(c.key), names)),
			),
		};
	}

	#hidden(key: ChannelKey, record?: ConversationRecord): boolean {
		return (
			(this.#ports.exclude?.(key, record) ?? false) ||
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
		visitor?: Visitor,
	): Promise<TranscriptView> {
		const { sessionsDir, relayNotes } = this.#ports;
		const record = await this.#ports.registry?.get(key as ChannelKey);
		const parsed = await this.#located(key);
		// Anyone but an owner reads only a private conversation of their own, which the registry records.
		const mayRead =
			visitor === undefined ||
			visitor.tier === "owner" ||
			(record?.visibility === "private" &&
				record.principalId === visitor.principal.id);
		if (!parsed || !mayRead || this.#hidden(key as ChannelKey, record))
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
				record,
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
}
