import type { ChannelKey, TeamPlace } from "pi-roundtable";
import { agentRoomKey, groupRoomKey, MemoryError } from "pi-roundtable";
import { thinkingLabel } from "pi-roundtable/kit";
import type {
	ApiError,
	ConfigView,
	ConversationsView,
	DashboardView,
	OverviewView,
	PaneName,
	PrincipalsView,
	TranscriptView,
} from "./api-types.ts";
import { readBody } from "./console-body.ts";
import type { ConsolePorts } from "./console-ports.ts";
import { ConversationViews } from "./conversation-views.ts";
import { message, safeAdminUrl } from "./features.ts";
import { NotesApi } from "./notes-api.ts";
import type { Visitor } from "./visitors.ts";

export type { AccessView, ConsolePorts } from "./console-ports.ts";

import { cleanupConversation } from "./cleanup-api.ts";
import { connectorRoutes, grantRoutes } from "./connector-manage-api.ts";
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

/** The channel id of an agent's or group's Discord place, read from its places, which the pane links by id; none without one. */
function discordChannel(
	places: readonly TeamPlace[] | undefined,
): { channelId: string } | Record<string, never> {
	const key = places?.find((place) => place.surface === "discord")?.key;
	return key ? { channelId: key.slice(key.indexOf(":") + 1) } : {};
}

/**
 * The console's JSON API under `<mount>/api/`. Every handler answers JSON; errors never repeat
 * the request URL or headers.
 */
export class ConsoleApi {
	readonly #ports: ConsolePorts;

	readonly #conversations: ConversationViews;
	readonly #notes: NotesApi;

	constructor(ports: ConsolePorts) {
		this.#ports = ports;
		this.#conversations = new ConversationViews(ports);
		this.#notes = new NotesApi(ports);
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

	/** The panes this visitor is served: the owners' list, or their own tier's. */
	#panesOf(visitor: Visitor): readonly PaneName[] {
		return visitor.tier === "owner"
			? this.#ports.panes
			: (this.#ports.tierPanes?.[visitor.tier] ?? []);
	}

	#pane(name: PaneName, visitor: Visitor): void {
		if (!this.#panesOf(visitor).includes(name))
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
			return json(await this.configFor(visitor));
		if (
			method === "GET" &&
			(head === "overview" || head === "dashboard") &&
			!id
		) {
			this.#pane("overview", visitor);
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
					key: group.channelId ? `discord:${group.channelId}` : "",
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
			this.#pane("conversations", visitor);
			if (!id) return json(await this.conversations(visitor));
			const archive = new URL(request.url).searchParams.get("archive");
			return json(await this.transcript(id, archive ?? undefined, visitor));
		}
		if (method === "POST" && head === "channels" && id && parts.length === 3) {
			this.#pane("overview", visitor);
			if (parts[2] === "start-over" || parts[2] === "delete")
				return cleanupConversation(this.#ports, id, parts[2]);
		}
		if (method === "GET" && head === "skills" && parts.length <= 2) {
			this.#pane("skills", visitor);
			const skills = this.#ports.features?.skills;
			if (!skills) throw new HttpError(404, "This pane is not served.");
			return json(id ? await skillDetail(skills, id) : skillCatalog(skills));
		}
		if (method === "GET" && head === "connectors" && parts.length === 1) {
			this.#pane("connectors", visitor);
			const connectors = this.#ports.features?.connectors;
			if (!connectors) throw new HttpError(404, "This pane is not served.");
			return json(await connectorsView(connectors));
		}
		if (
			head === "connectors" &&
			(id === "managed" || id === "grants") &&
			parts.length >= 2
		)
			return this.#manage(request, parts.slice(1), visitor);
		if (head === "notes" && parts.length <= 2) {
			this.#pane("notes", visitor);
			return this.#notes.notes(request, id, visitor);
		}
		if (method === "GET" && head === "principals" && !id) {
			this.#pane("notes", visitor);
			return json(await this.principals(visitor));
		}
		throw new HttpError(404, "There is no such API.");
	}

	/** Connector and MCP authorization management: the owners' alone, whatever panes another tier has. */
	async #manage(
		request: Request,
		parts: string[],
		visitor: Visitor,
	): Promise<Response> {
		this.#pane("connectors", visitor);
		if (visitor.tier !== "owner")
			throw new HttpError(403, "Only an owner may do this.");
		const [area, ...rest] = parts;
		const { features, logger } = this.#ports;
		const context = {
			logger,
			actor: {
				principalId: visitor.principal.id,
				speakerId: visitor.speakerId,
			},
			body: () => readBody(request),
			changed: () => this.#ports.changed(),
		};
		const manage = features?.connectors?.manage;
		if (area === "managed" && manage && rest.length <= 1)
			return connectorRoutes(manage, request.method, rest[0], context);
		const grants = features?.mcpGrants;
		if (area === "grants" && grants && rest.length <= 2)
			return grantRoutes(grants, request.method, rest, context);
		throw new HttpError(404, "There is no such API.");
	}

	/**
	 * The page's config for a visitor: the owners' view as it was, and for another tier the panes
	 * of that tier. Where the app admits more than its owners it also says the visitor's tier, the
	 * steps they owe, the pages and kinds of room they may see, and who gets push.
	 */
	async configFor(visitor: Visitor): Promise<ConfigView> {
		const view = this.config();
		const { access } = this.#ports;
		const hosted = (await this.#ports.hosted?.(visitor)) ?? {
			pages: [],
			kinds: [],
		};
		if (!access)
			return {
				...view,
				...(hosted.pages.length > 0 ? { pages: hosted.pages } : {}),
				...(hosted.kinds.length > 0 ? { kinds: hosted.kinds } : {}),
			};
		const owed = await access.gate(visitor);
		return {
			...view,
			panes: [...this.#panesOf(visitor)],
			tier: visitor.tier,
			...(owed.length > 0 ? { gate: owed } : {}),
			pages: hosted.pages,
			kinds: hosted.kinds,
			push: {
				tiers: [...access.push.tiers],
				...(access.push.key ? { key: access.push.key } : {}),
				...(access.push.subscribe ? { subscribe: access.push.subscribe } : {}),
			},
		};
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
			...(features?.connectors || features?.mcpGrants
				? {
						connectorParts: {
							...(features.connectors ? { gateways: true as const } : {}),
							...(features.connectors?.manage ? { manage: true as const } : {}),
							...(features.mcpGrants ? { grants: true as const } : {}),
						},
					}
				: {}),
			look: this.#ports.look ?? "modern",
			...(this.#ports.characterSkins
				? { characterSkins: [...this.#ports.characterSkins] }
				: {}),
			...(this.#ports.mountPath ? { mountPath: this.#ports.mountPath } : {}),
			...(this.#ports.app ? { app: this.#ports.app } : {}),
		};
	}

	// ── Overview ───────────────────────────────────────────────────────────

	async overview(): Promise<OverviewView> {
		const { team } = this.#ports;
		if (!team) throw new HttpError(404, "This pane is not served.");
		const status = await team.status();
		const { features, roomSurface } = this.#ports;
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
			guildId: team.discordGuild ?? team.guildId,
			agents: status.agents.map((agent) => ({
				name: agent.name,
				displayName: agent.displayName,
				...discordChannel(agent.places),
				...(roomSurface ? { room: agentRoomKey(roomSurface, agent.name) } : {}),
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
				// A group of a team without Discord has no channel; the pane then links none.
				...discordChannel(group.places),
				...(roomSurface ? { room: groupRoomKey(roomSurface, group.name) } : {}),
				members: group.members,
				host: group.host,
				busy: group.busy,
				...(group.lastActive ? { lastActive: iso(group.lastActive) } : {}),
			})),
		};
	}

	// ── Conversations ──────────────────────────────────────────────────────

	conversations(visitor?: Visitor): Promise<ConversationsView> {
		return this.#conversations.conversations(visitor);
	}

	transcript(
		key: string,
		archive: string | undefined,
		visitor?: Visitor,
	): Promise<TranscriptView> {
		return this.#conversations.transcript(key, archive, visitor);
	}

	// ── Notes ──────────────────────────────────────────────────────────────

	principals(visitor: Visitor): Promise<PrincipalsView> {
		return this.#notes.principals(visitor);
	}
}
