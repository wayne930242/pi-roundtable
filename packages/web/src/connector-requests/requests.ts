import {
	type ChannelKey,
	type InboundMessage,
	type Logger,
	serviceKey,
} from "pi-roundtable";
import type {
	ConnectorAddedView,
	ConnectorAddRequestView,
	RoomMessage,
} from "../api-types.ts";
import { coreMessageId } from "../app/queued-delivery.ts";
import type { NewRoomMessage } from "../app/room-log.ts";
import {
	connectorView,
	displayUrl,
	guarded,
	type ManageContext,
	objectBody,
	optional,
	required,
} from "../connector-manage-api.ts";
import type { ConnectorManagement } from "../features.ts";
import { ConsoleHttpError as HttpError, json } from "../http.ts";
import type { ConnectorAddRequestStore, StoredAddRequest } from "./store.ts";

/** How long an add request lasts. */
export const ADD_REQUEST_MINUTES = 60;

/** What an agent's `connector_add` asks for: never a URL or a token. */
export interface NewAddRequest {
	name: string;
	description: string;
	conversation: string;
	requestedBy: string;
}

/** The service pi-roundtable-mcp's `connector_add` reads, matched on its id. */
export interface ConnectorAddRequestsService {
	readonly minutes: number;
	create(request: NewAddRequest): Promise<{ link: string } | undefined>;
}

export const CONNECTOR_ADD_REQUESTS = serviceKey<ConnectorAddRequestsService>(
	"pi-roundtable-web.connector-add-requests",
);

/** Where a follow-up is shown and handed to the host, as a webhook's post is. */
export interface FollowUpSurface {
	publish(row: NewRoomMessage): Promise<RoomMessage>;
	deliver(message: InboundMessage): void;
}

export interface ConnectorAddRequestsOptions {
	store: ConnectorAddRequestStore;
	/** The connector management; undefined when the host serves none, so no request is made. */
	manage: ConnectorManagement | undefined;
	/** The app's surface once it is built; undefined on a console without the app. */
	surface: () => FollowUpSurface | undefined;
	/** The key prefix of the app's conversations, such as `app`; only they can be followed up. */
	surfaceName: string;
	/** The page address that opens the add form for a request. */
	link(id: string): string;
	now?: () => number;
	logger: Logger;
}

const NOT_FOUND = "There is no such add request.";
const DOWN = "the connector service did not respond";
const URLS = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>`]+/gi;

/** A reason with every URL cut to its scheme and host, and the given secrets taken out. */
export function scrubbed(reason: string, secrets: readonly string[]): string {
	let text = reason.replace(URLS, (url) => displayUrl(url) ?? "(a URL)");
	// A secret the pattern missed, such as a URL without a scheme or a header token.
	for (const secret of secrets)
		if (secret.length >= 4) text = text.replaceAll(secret, "…");
	return text;
}

/**
 * The one-time requests an agent makes to add a connector: the owner opens the link on the
 * connectors page, pastes the URL into the add form there, and that submission is the approval.
 * The request keeps no URL, and the follow-up the asking conversation gets names the host only.
 */
export class ConnectorAddRequests {
	readonly minutes = ADD_REQUEST_MINUTES;
	readonly #options: ConnectorAddRequestsOptions;

	constructor(options: ConnectorAddRequestsOptions) {
		this.#options = options;
	}

	/** Makes a request; undefined when no add form or follow-up reaches the conversation. */
	async create(request: NewAddRequest): Promise<{ link: string } | undefined> {
		const { manage, surface, surfaceName, store } = this.#options;
		if (!manage || !surface()) return undefined;
		if (!request.conversation.startsWith(`${surfaceName}:`)) return undefined;
		const now = this.#options.now?.() ?? Date.now();
		const id = await store.create({
			...request,
			conversation: request.conversation as ChannelKey,
			expiresAt: new Date(now + this.minutes * 60_000),
		});
		return { link: this.#options.link(id) };
	}

	async #live(id: string): Promise<StoredAddRequest> {
		const found = await this.#options.store.live(id);
		if (!found) throw new HttpError(404, NOT_FOUND);
		return found;
	}

	/** `connectors/requests/<id>`: read the request to fill the form (`GET`), or add the connector (`POST`). */
	async route(
		method: string,
		id: string,
		context: ManageContext,
	): Promise<Response> {
		const manage = this.#options.manage;
		if (!manage) throw new HttpError(404, NOT_FOUND);
		if (method === "GET") {
			const found = await this.#live(id);
			return json({
				id: found.id,
				name: found.name,
				description: found.description,
				expiresAt: found.expiresAt.toISOString(),
			} satisfies ConnectorAddRequestView);
		}
		if (method !== "POST")
			throw new HttpError(405, "This method is not supported.");
		await this.#live(id);
		const body = await objectBody(context);
		const header = optional(body.header, 100);
		const token = optional(body.token, 4000);
		const url = required(body.url, 2000);
		const name = optional(body.name, 100);
		const description = optional(body.description, 1000);
		// Taken before the add, so a second submission of the same link is refused whatever this one does.
		const request = await this.#options.store.claim(id);
		if (!request) throw new HttpError(404, NOT_FOUND);
		const input = {
			name: name ?? request.name,
			url,
			description: description ?? request.description,
			...(header ? { header } : {}),
			...(token ? { token } : {}),
		};
		const host = displayUrl(url.trim()) ?? "(a URL that cannot be parsed)";
		try {
			const added = await guarded(context, "connectors", () =>
				manage.add(input),
			);
			context.changed();
			await this.#followUp(
				request,
				`The owner added connector ${added.connector.name} (${host}) from your link. ${added.connector.server ? `${added.connector.server.tools.length} tools are available` : "Its tools cannot be read yet"}${added.skipped.length > 0 ? `; ${added.skipped.length} were left out for their long names` : ""}. From the next message on, you can use it.`,
			);
			return json(
				{
					connector: connectorView(added.connector),
					skipped: [...added.skipped],
				} satisfies ConnectorAddedView,
				201,
			);
		} catch (error) {
			const reason =
				error instanceof HttpError && error.status === 400
					? error.message
					: DOWN;
			await this.#followUp(
				request,
				`The owner's add of connector ${input.name} (${host}) failed: ${scrubbed(
					reason,
					[
						url.trim(),
						`${URL.parse(url.trim())?.pathname ?? ""}${URL.parse(url.trim())?.search ?? ""}`,
						token ?? "",
					],
				)}. The link is used up; make a new one with connector_add if they want to try again.`,
			);
			throw error;
		}
	}

	/** Shows the outcome in the asking conversation and starts a turn there; never fails the add. */
	async #followUp(request: StoredAddRequest, text: string): Promise<void> {
		const surface = this.#options.surface();
		if (!surface) return;
		try {
			const shown = await surface.publish({
				room: request.conversation,
				kind: "integration",
				author: "Connectors",
				text,
				files: [],
			});
			surface.deliver({
				channel: request.conversation,
				messageId: coreMessageId(shown.id),
				authorId: `connector-add:${request.id}`,
				authorName: "Connectors",
				authorIsBot: true,
				integration: { id: `connector-add:${request.id}`, own: false },
				isDirect: false,
				mentionsBot: false,
				repliesToBot: false,
				text,
				attachments: [],
			});
		} catch (error) {
			// The error is about the room, never the connector; the add itself stands.
			this.#options.logger.warn(
				{ err: error, request: request.id },
				"web-console: the connector add follow-up was not delivered",
			);
		}
	}
}
