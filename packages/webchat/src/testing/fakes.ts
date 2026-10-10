import type {
	ChannelKey,
	ConversationPort,
	ConversationRecord,
	ConversationRegistry,
	IdentityService,
	RouteSocket,
	Speaker,
	Tier,
	WebSocketSendResult,
} from "pi-roundtable";
import { partial, silentLogger } from "pi-roundtable/testing";
import { WebChat, type WebChatDeps, type WebChatLimits } from "../chat.ts";
import type { Connection } from "../connections.ts";
import type { WebIdentity } from "../oidc.ts";
import type { ServerFrame } from "../protocol.ts";
import { DEFAULT_ATTACHMENT_TYPES } from "../uploads.ts";
import { memoryAttachments } from "./memory-attachments.ts";

/**
 * The registry's behavior in memory: first registration fixes the record, later ones touch it, and
 * `adopt` makes only a shared record of no principal private.
 */
export function memoryRegistry(): ConversationRegistry & {
	records: Map<ChannelKey, ConversationRecord>;
} {
	const records = new Map<ChannelKey, ConversationRecord>();
	return {
		records,
		register: async (entry) => {
			const now = new Date();
			const known = records.get(entry.key);
			const record: ConversationRecord = known
				? { ...known, lastActiveAt: now }
				: {
						...entry,
						surface: entry.key.slice(0, entry.key.indexOf(":")),
						createdAt: now,
						lastActiveAt: now,
					};
			records.set(entry.key, record);
			return record;
		},
		get: async (key) => records.get(key),
		list: async (filter) =>
			[...records.values()].filter(
				(record) =>
					filter?.principal === undefined ||
					record.principalId === filter.principal,
			),
		adopt: async (key, principalId) => {
			const known = records.get(key);
			if (known?.visibility !== "shared" || known.principalId !== undefined)
				return known;
			const adopted: ConversationRecord = {
				...known,
				visibility: "private",
				principalId,
			};
			records.set(key, adopted);
			return adopted;
		},
		setTitle: async () => undefined,
	};
}

/** A socket that records the frames sent to it, as the person's browser would receive them. */
export interface FakeSocket extends RouteSocket<Connection> {
	frames: ServerFrame[];
	closed?: { code?: number; reason?: string };
}

export function fakeSocket(connection: Connection): FakeSocket {
	const frames: ServerFrame[] = [];
	const socket: FakeSocket = {
		data: connection,
		frames,
		send: (message): WebSocketSendResult => {
			try {
				frames.push(JSON.parse(String(message)) as ServerFrame);
			} catch (error) {
				throw new Error("the adapter sent invalid JSON to the test socket", {
					cause: error,
				});
			}
			return "sent";
		},
		close: (code, reason) => {
			socket.closed = {
				...(code === undefined ? {} : { code }),
				...(reason === undefined ? {} : { reason }),
			};
		},
	};
	return socket;
}

export function identity(id: string, roles: string[] = []): WebIdentity {
	return {
		id,
		name: id,
		roles,
		expiresAt: new Date(Date.now() + 3_600_000),
	};
}

/** Small limits, so tests reach them quickly. */
export const TEST_LIMITS: WebChatLimits = {
	connectionsPerPrincipal: 2,
	unusedConversationsPerPrincipal: 3,
	newConversationsPerHour: 100,
	turnsPerPrincipal: 10,
	messageChars: 1000,
	promptTimeoutMs: 60_000,
	reauthLeadMs: 1_000,
	attachmentBytes: 1024,
	attachmentsPerMessage: 3,
	uploadsPerHour: 100,
	unsentUploadBytesPerPrincipal: 10_000,
	attachmentTypes: DEFAULT_ATTACHMENT_TYPES,
	unsentUploadTtlMs: 60_000,
};

/** A web chat over an in-memory registry, with a `helper` persona for members and an `ops` one for admins. */
export function testChat(overrides: Partial<WebChatDeps> = {}) {
	const registry = memoryRegistry();
	const stopped: ChannelKey[] = [];
	const principals = new Map<string, string>();
	const attachments = memoryAttachments();
	const chat = new WebChat({
		surface: "web",
		verifier: async () => {
			throw new Error("no tokens in this test");
		},
		identity: () =>
			partial<IdentityService>({
				resolve: async (facts) => {
					const id = facts.legacyId ?? facts.subject;
					const tier =
						id === "boss"
							? "owner"
							: facts.roles?.includes("web:role:Admin")
								? "admin"
								: facts.roles?.includes("web:role:User")
									? "member"
									: undefined;
					return tier
						? {
								id,
								name: facts.name,
								tier,
								principalId: principals.get(id) ?? id,
							}
						: undefined;
				},
			}),
		personas: [
			{ kind: "helper", label: "Helper", prompt: () => "Help." },
			{ kind: "ops", minTier: "admin" },
		],
		limits: TEST_LIMITS,
		logger: silentLogger(),
		registry: () => registry,
		attachments: () => attachments,
		conversations: () =>
			partial<ConversationPort>({
				stop: (channel) => {
					stopped.push(channel);
					return true;
				},
			}),
		turns: () => partial({}),
		runtime: () => partial({}),
		...overrides,
	});
	/** Connects a person: an authenticated socket, opened and greeted. */
	const connect = (
		id: string,
		roles: string[] = ["User"],
		principalId = id,
	) => {
		const tier =
			id === "boss" ? "owner" : roles.includes("Admin") ? "admin" : "member";
		principals.set(id, principalId);
		const admitted = {
			identity: identity(id, roles),
			speaker: { ...speakerOf(id, tier), principalId },
		};
		const connection: Connection = { ...admitted, timers: [] };
		if (!chat.connections.reserve(connection))
			throw new Error(`${id} holds every connection`);
		const socket = fakeSocket(connection);
		chat.opened(socket);
		return socket;
	};
	const say = (socket: FakeSocket, frame: Record<string, unknown>) =>
		chat.message(socket, JSON.stringify(frame));
	return { chat, registry, stopped, connect, say, attachments };
}

export const speakerOf = (id: string, tier: Tier = "member"): Speaker => ({
	id,
	name: id,
	tier,
	principalId: id,
});
