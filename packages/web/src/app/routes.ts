import type {
	AgentDirectory,
	AgentTeam,
	AvatarStudio,
	ChannelKey,
	ConversationModes,
	ConversationPort,
	IdentityService,
	Logger,
	ModeChange,
	ScheduleStore,
	SkillRegistry,
	Speaker,
} from "pi-roundtable";
import { channelKey, PluginError } from "pi-roundtable";
import { CharacterError } from "pi-roundtable/characters";
import { AgentError } from "pi-roundtable/kit";
import type {
	ApiError,
	CharacterRefusal,
	MessagesView,
	ModelsView,
	ReadAllUndone,
	ReadAllView,
	RoomOneView,
	RoomsView,
	SchedulesView,
	ScheduleView,
	SessionView,
	SkillView,
	ThreadsDismissed,
	ThreadsDismissedAll,
	ThreadsRestored,
	WorkspaceConflict,
	WorkspaceNew,
	WorkspaceRefusalBody,
	WorkspaceRename,
	WorkspaceRootsView,
	WorkspaceSave,
} from "../api-types.ts";
import { isStartOver } from "../api-types.ts";
import type { Authenticated } from "../auth/authenticator.ts";
import { type ConsolePresentation, message } from "../features.ts";
import type { Gate } from "../gate.ts";
import type { HostApp } from "../host/host-app.ts";
import { MAX_READ_ALL } from "../host/read-all.ts";
import type { RoomReads } from "../host/reads.ts";
import { readsOf, withExpiredFiles } from "../host/room-views.ts";
import { json } from "../http.ts";
import type { ResolvedOptions } from "../options.ts";
import type { PushMutes } from "../push/mutes.ts";
import { viewerOf, type WebAppRegistry } from "../web-app.ts";
import { bad, bodyOf, HttpError, notFound } from "./api-http.ts";
import type { CardLog } from "./card-log.ts";
import { type FileDir, fileResponse, isFileId } from "./files.ts";
import { HelperRoutes } from "./helper-routes.ts";
import type { LayoutStore } from "./layout.ts";
import { LayoutRoutes } from "./layout-routes.ts";
import { PromptApi, type PromptApiOptions } from "./prompt-routes.ts";
import { PAGE_LIMIT, type RoomLog } from "./room-log.ts";
import type { ResolvedRoom, Rooms } from "./rooms.ts";
import { SkillDocApi } from "./skill-doc-routes.ts";
import type { AppSurface } from "./surface.ts";
import { TeamApi } from "./team-routes.ts";
import type { WebThreads } from "./threads.ts";
import { UploadRefusal, type Uploads } from "./uploads.ts";
import {
	EDIT_MAX_BYTES,
	WorkspaceConflictError,
	type WorkspaceFiles,
	WorkspaceRefusal,
} from "./workspace-files.ts";

/** The most threads one request puts back on the room list: more than the list ever shows. */
const MAX_RESTORED = 100;
/** The most rooms one bulk request names. */
const MAX_BULK_ROOMS = MAX_READ_ALL;

export interface AppApiOptions {
	/** The host's wording: a refusal reaches a client of the API in this locale when the catalog has it. */
	presentation?: ConsolePresentation;
	surface: AppSurface;
	rooms: Rooms;
	log: Pick<RoomLog, "page" | "lastOf" | "removeRoom" | "get" | "startOver">;
	cards: Pick<CardLog, "during" | "removeRoom">;
	uploads: Uploads;
	/** Where stored files are read from. */
	files: FileDir;
	modes: Pick<ConversationModes, "set" | "peek">;
	/** The rooms whose push the owners muted. */
	mutes: Pick<PushMutes, "set" | "setMany">;
	/** The dispatch threads, which go with the room they hang under. */
	threads: Pick<
		WebThreads,
		| "under"
		| "removeUnder"
		| "dismiss"
		| "dismissFinished"
		| "dismissFinishedUnder"
		| "restore"
		| "restoreFinished"
	>;
	/** The owners' shared arrangement of the room list: pins and folders. */
	layout: LayoutStore;
	conversations: Pick<ConversationPort, "startFresh">;
	identity: Pick<IdentityService, "principal">;
	/** Present when the schedules pane is served. */
	schedules?: Pick<ScheduleStore, "all" | "get" | "remove">;
	directory: Pick<AgentDirectory, "agent" | "agents" | "group" | "groups">;
	team: Pick<
		AgentTeam,
		| "update"
		| "promptHistory"
		| "dress"
		| "usableModels"
		| "modelOf"
		| "defaultModel"
		| "createAgent"
		| "archive"
		| "restore"
		| "remove"
		| "createGroup"
		| "updateGroup"
		| "finishedHelpers"
		| "archiveHelpers"
		| "restoreHelpers"
	>;
	/** Present when the host has the skills addon: the catalog an agent's skills are chosen from, and the change of what it carries. */
	skills?: {
		catalog(): SkillView[];
		attach(
			agent: string,
			add: readonly string[],
			remove: readonly string[],
		): Promise<string[]>;
		/** The registry's documents: a skill's SKILL.md read, saved and made, and its versions. */
		documents: Pick<
			SkillRegistry,
			"document" | "saveDocument" | "createDocument" | "documentHistory"
		>;
	};
	/** Present when the host has prompt documents (the prompts plugin): the main prompts the owner edits. */
	prompts?: PromptApiOptions["prompts"];
	avatars: Pick<AvatarStudio, "serve">;
	/** The read cursors, for each room's unread count and who has read what. */
	reads?: Pick<RoomReads, "unread" | "cursorOf" | "marks">;
	/** Who may be served a file bound to a host room or a page. */
	host?: Pick<HostApp, "mayRead" | "readAll" | "unreadAll">;
	/** The name the app shows for a person. */
	nameOf?(principalId: string): Promise<string>;
	/** Present when the workspace pane is served. */
	workspace?: WorkspaceFiles;
	/** The mount, which a room's agent picture hangs under. */
	mount: string;
	/** How the console signs the person in, as the session reports it. */
	authMode: SessionView["auth"];
	/** Who the app admits; the session reports the person's tier only where it admits more than owners. */
	admission?: ResolvedOptions["admission"];
	/** The area handlers the pieces of the app plug in; without it the API is the owners' as in 0.25. */
	registry?: Pick<WebAppRegistry, "areaFor">;
	/** The onboarding gate; without it nobody is gated. */
	gate?: Pick<Gate, "required">;
	/** The tiers whose people may use push; default owners. */
	pushTiers?: ResolvedOptions["push"]["tiers"];
	/** Whether the yolo and long-running switches are served; `PUT rooms/<key>/mode` answers 404 without them. Default true. */
	modeSwitches?: boolean;
	/** The quiet hours of push, as the settings page shows them. */
	quietHours?: NonNullable<SessionView["quietHours"]>;
	/** Called after a change the other pages should refetch. */
	changed(): void;
	logger: Logger;
}

/** A cursor move as the page sends it back to undo a marking. */
const isReadMove = (
	value: unknown,
): value is { room: string; from: number; to: number } => {
	if (typeof value !== "object" || value === null) return false;
	const { room, from, to } = value as Record<string, unknown>;
	return (
		typeof room === "string" &&
		room.length <= 300 &&
		Number.isSafeInteger(from) &&
		(from as number) >= 0 &&
		Number.isSafeInteger(to) &&
		(to as number) >= 0
	);
};

/** A refusal of the workspace pane as the HTTP error the owner reads. */
function refusalOf(refusal: WorkspaceRefusal): HttpError {
	const { status } = refusal;
	switch (refusal.reason) {
		case "bad-path":
			return new HttpError(status, "That path is not allowed.");
		case "unknown-root":
			return new HttpError(status, "There is no such place.");
		case "not-found":
			return new HttpError(status, "There is no such file or folder.");
		case "not-a-dir":
			return new HttpError(status, "That is not a folder.");
		case "is-a-dir":
			return new HttpError(status, "That is a folder, not a file.");
		case "is-root":
			return new HttpError(
				status,
				"That is the top folder, which cannot be changed.",
			);
		case "outside":
			return new HttpError(status, "That points outside the workspace.");
		case "special":
			return new HttpError(status, "That is not a regular file.");
		case "symlink":
			return new HttpError(
				status,
				"That is a link; open the file it points to.",
			);
		case "read-only-root":
			return new HttpError(status, "This place is read-only.");
		case "git-dir":
			return new HttpError(status, "Files inside .git are read-only.");
		case "trash-dir":
			return new HttpError(status, "The trash cannot be changed this way.");
		case "binary":
			return new HttpError(
				status,
				"This file is not text, so it cannot be edited.",
			);
		case "not-utf8":
			return new HttpError(
				status,
				"This file is not UTF-8 text, so it cannot be edited.",
			);
		case "too-large":
			return new HttpError(status, "This file is too large.");
		case "text-too-large":
			return new HttpError(
				status,
				"The text is too large to save (1 MiB at most).",
			);
		case "into-itself":
			return new HttpError(status, "A folder cannot be moved into itself.");
		case "cross-device":
			return new HttpError(status, "That cannot be moved to another disk.");
		case "permission":
			return new HttpError(status, "The server is not allowed to change that.");
	}
}

/** A conflict of the workspace pane as the HTTP error the owner reads. */
function conflictOf(conflict: WorkspaceConflictError): HttpError {
	switch (conflict.conflict) {
		case "changed":
			return new HttpError(409, "This file changed while you were editing.");
		case "gone":
			return new HttpError(409, "This file is gone.");
		case "exists":
			return new HttpError(409, "Something with that name is already there.");
	}
}

/** The parts of a path under the mount, each decoded; undefined for one that is not valid. */
export function partsOf(path: string): string[] | undefined {
	try {
		return path.split("/").filter(Boolean).map(decodeURIComponent);
	} catch {
		return undefined;
	}
}

/**
 * The owner app's REST under `<mount>/api/` and `<mount>/avatars/`. Every route is behind the
 * authenticator, which also checks the `Origin` of a write; a write also reads the person's tier
 * again. A room in a path is one of the app's rooms or the answer is 404, so no other surface's
 * key is ever read or changed here.
 */
export class AppApi {
	readonly #options: AppApiOptions;
	readonly #team: TeamApi;
	readonly #layout: LayoutRoutes;
	readonly #helpers: HelperRoutes;
	readonly #prompts: PromptApi | undefined;
	readonly #skillDocs: SkillDocApi | undefined;

	constructor(options: AppApiOptions) {
		this.#options = options;
		this.#layout = new LayoutRoutes({
			layout: options.layout,
			mutes: options.mutes,
			placeable: () => options.rooms.placeable(),
			home: () => options.rooms.homeKey(),
			owner: (admission) => this.#owner(admission),
			changed: () => options.changed(),
		});
		this.#helpers = new HelperRoutes({
			surface: options.surface.surface,
			directory: options.directory,
			team: options.team,
			changed: () => options.changed(),
		});
		this.#prompts = options.prompts
			? new PromptApi({ prompts: options.prompts })
			: undefined;
		this.#skillDocs = options.skills
			? new SkillDocApi({
					skills: options.skills.documents,
					catalog: () => options.skills?.catalog() ?? [],
				})
			: undefined;
		this.#team = new TeamApi({
			surface: options.surface.surface,
			rooms: options.rooms,
			directory: options.directory,
			team: options.team,
			skills: options.skills,
			log: options.log,
			cards: options.cards,
			mutes: options.mutes,
			modes: options.modes,
			threads: options.threads,
			layout: options.layout,
			changed: () => options.changed(),
		});
	}

	/** Answers a path of the app's, or undefined for any other. `rest` is what follows the mount. */
	async handle(
		request: Request,
		rest: string,
		admission: Authenticated,
	): Promise<Response | undefined> {
		const response = await this.#answer(request, rest, admission);
		return response && this.#options.presentation
			? this.#worded(response, this.#options.presentation)
			: response;
	}

	/** A refusal's `error` in the host's wording; the page words it again from the same catalog and finds the wording already there. */
	async #worded(
		response: Response,
		presentation: ConsolePresentation,
	): Promise<Response> {
		if (response.status < 400) return response;
		const body: unknown = await response
			.clone()
			.json()
			.catch(() => undefined);
		const error = (body as { error?: unknown } | undefined)?.error;
		if (typeof error !== "string") return response;
		const worded = message(presentation, error);
		if (worded === error) return response;
		const headers = new Headers(response.headers);
		headers.delete("content-length");
		return new Response(
			JSON.stringify({ ...(body as object), error: worded }),
			{
				status: response.status,
				headers,
			},
		);
	}

	async #answer(
		request: Request,
		rest: string,
		admission: Authenticated,
	): Promise<Response | undefined> {
		const parts = partsOf(rest);
		if (!parts) return undefined;
		const [first, second] = parts;
		const area =
			first === "api" && second !== undefined
				? this.#options.registry?.areaFor(second)
				: undefined;
		const mine =
			area !== undefined ||
			(first === "avatars" && parts.length === 2) ||
			(first === "api" &&
				[
					"session",
					"rooms",
					"folders",
					"uploads",
					"files",
					"schedules",
					"agents",
					"groups",
					"archive",
					"models",
					"workspace",
					"prompts",
					"skill-docs",
				].includes(second ?? ""));
		if (!mine) return undefined;
		try {
			if (area)
				return await area.handle(request, parts.slice(2), {
					visitor: admission.visitor,
					viewer: viewerOf(admission.visitor),
				});
			return await this.#route(request, parts, admission);
		} catch (error) {
			if (error instanceof HttpError || error instanceof UploadRefusal)
				return json({ error: error.message } satisfies ApiError, error.status);
			if (error instanceof CharacterError)
				return json(
					{
						error: error.message,
						field: error.field,
					} satisfies CharacterRefusal,
					400,
				);
			if (error instanceof AgentError || error instanceof PluginError)
				return json({ error: error.message } satisfies ApiError, 400);
			this.#options.logger.error({ err: error }, "app api failed");
			return json(
				{ error: "The app could not complete the request." } satisfies ApiError,
				500,
			);
		}
	}

	/** The owner who writes: the tier the request was admitted at, as a speaker for the calls that need one. */
	async #owner(admission: Authenticated): Promise<Speaker> {
		const { principal, tier, speakerId } = admission.visitor;
		if (tier !== "owner")
			throw new HttpError(403, "Only an owner may do this.");
		return {
			id: speakerId,
			name: principal.displayName,
			tier,
			principalId: principal.id,
		};
	}

	async #route(
		request: Request,
		parts: string[],
		admission: Authenticated,
	): Promise<Response> {
		const { method } = request;
		const [head, area, id, action] = parts;
		if (head === "avatars") {
			if (method !== "GET") throw new HttpError(405, "Method not allowed.");
			return (
				this.#options.avatars.serve(`/avatars/${parts[1]}`) ??
				new Response("Not found", { status: 404 })
			);
		}
		if (area === "session" && method === "GET")
			return await this.#session(admission);
		if (area === "models" && method === "GET")
			return json({
				models: await this.#options.team.usableModels(),
			} satisfies ModelsView);
		if (area === "rooms") return this.#rooms(request, parts, admission);
		if (area === "folders")
			return this.#layout.folders(request, parts, admission);
		// An upload is the sender's own, whoever they are; a file answers by the room it is bound to.
		if (area === "uploads" && method === "POST" && !id)
			return json(
				await this.#options.uploads.receive(
					request,
					admission.visitor.principal.id,
				),
			);
		if (area === "uploads" && method === "DELETE" && id && !action) {
			if (!this.#options.uploads.discard(id, admission.visitor.principal.id))
				throw notFound();
			return json({ ok: true });
		}
		if (area === "files" && method === "GET" && id && !action)
			return await this.#file(id, admission);
		if (area === "workspace") return this.#workspace(request, parts, admission);
		if (area === "schedules") return this.#schedules(method, id, admission);
		const owner = () => this.#owner(admission);
		if (area === "agents") return this.#team.agents(request, parts, owner);
		if (area === "groups") return this.#team.groups(request, parts, owner);
		if (area === "archive" && method === "GET" && !id)
			return this.#team.archived(owner);
		if (area === "prompts") {
			if (!this.#prompts)
				throw new HttpError(404, "This host has no prompts to edit.");
			return this.#prompts.handle(request, parts, owner);
		}
		if (area === "skill-docs") {
			if (!this.#skillDocs)
				throw new HttpError(404, "This host has no skills.");
			return this.#skillDocs.handle(request, parts, owner);
		}
		throw new HttpError(404, "There is no such API.");
	}

	async #session(admission: Authenticated): Promise<Response> {
		const { principal, tier } = admission.visitor;
		const { admission: admits = "owners", gate } = this.#options;
		const pushTiers = this.#options.pushTiers ?? ["owner"];
		const owed =
			admits === "access" && gate
				? await gate.required(viewerOf(admission.visitor))
				: [];
		return json({
			principal: { id: principal.id, name: principal.displayName },
			surface: this.#options.surface.surface,
			auth: this.#options.authMode,
			...(admits === "access" ? { tier } : {}),
			...(owed.length > 0 ? { gate: owed } : {}),
			...(pushTiers.includes(tier) ? { push: true as const } : {}),
			...(this.#options.prompts ? { prompts: true } : {}),
			...(this.#options.skills ? { skillEdit: true } : {}),
			...(this.#options.quietHours
				? { quietHours: this.#options.quietHours }
				: {}),
			...(admission.expiresAt
				? { expiresAt: admission.expiresAt.toISOString() }
				: {}),
		} satisfies SessionView);
	}

	async #rooms(
		request: Request,
		parts: string[],
		admission: Authenticated,
	): Promise<Response> {
		const { method } = request;
		const [, , key, action] = parts;
		const { rooms, log, cards, modes, mutes, conversations } = this.#options;
		// The agent rooms are the owners'; to anyone else this API does not exist.
		if (admission.visitor.tier !== "owner") throw notFound();
		if (!key) {
			if (method !== "GET") throw new HttpError(405, "Method not allowed.");
			const listed = await rooms.list();
			// What each room holds past this person's cursor; a room they never read starts from what it has now.
			const unread = await this.#options.reads?.unread(
				admission.visitor.principal.id,
				listed.map((one) => one.key),
				new Set(listed.map((one) => one.key)),
			);
			return json({
				rooms: listed.map((one) => {
					const count = unread?.get(one.key);
					return count ? { ...one, unread: count } : one;
				}),
				...(await this.#layout.view()),
			} satisfies RoomsView);
		}
		// No room key is a bare word: the bulk calls take that place.
		if (key === "read-all" && !action && method === "POST")
			return this.#readAll(request, admission);
		if (key === "dismiss-finished-threads" && !action && method === "POST")
			return this.#dismissAllFinished(request, admission);
		if (key === "archive-finished-helpers" && !action && method === "POST")
			return this.#helpers.archiveFinished(
				request,
				await this.#owner(admission),
			);
		if (key === "restore-helpers" && !action && method === "POST") {
			await this.#owner(admission);
			return this.#helpers.restore(request);
		}
		const room = await rooms.resolve(key);
		if (!room) throw notFound();
		if (!action && method === "GET") {
			// A thread dismissed from the list still opens by its address; the page asks for its view.
			const view = await rooms.threadView(room.key);
			if (!view) throw notFound();
			return json({ room: view } satisfies RoomOneView);
		}
		if (action === "dismiss" && method === "POST" && parts.length === 4)
			return this.#dismiss(room, admission);
		if (action === "dismiss-threads" && method === "POST" && parts.length === 4)
			return this.#dismissFinished(room, admission);
		if (action === "undismiss" && method === "POST" && parts.length === 4)
			return this.#restore(room, admission);
		if (
			action === "undismiss-threads" &&
			method === "POST" &&
			parts.length === 4
		)
			return this.#restoreFinished(room, request, admission);
		if (action === "messages" && method === "GET" && parts.length === 4) {
			const params = new URL(request.url).searchParams;
			const before = params.get("before");
			const limit = params.get("limit");
			const archive = params.get("archive");
			const beforeId = before === null ? undefined : Number(before);
			const archiveId = archive === null ? undefined : Number(archive);
			const count = limit === null ? PAGE_LIMIT : Number(limit);
			if (
				(beforeId !== undefined && !Number.isInteger(beforeId)) ||
				(archiveId !== undefined && !Number.isInteger(archiveId)) ||
				!Number.isInteger(count) ||
				count < 1
			)
				throw bad("before, limit and archive must be whole numbers.");
			if (archiveId !== undefined)
				return json(await this.#archived(room.key, archiveId, beforeId, count));
			const page = await log.page(room.key, beforeId, count);
			// The cards stand among the messages by the time they opened; a page that has older
			// messages leaves the cards before its first one to the older page, and a conversation
			// started over leaves the archived one's cards to it.
			const first = page.messages[0];
			const { reads, nameOf } = this.#options;
			const self = admission.visitor.principal.id;
			const cursor = await reads?.cursorOf(room.key, self);
			return json({
				...page,
				messages: withExpiredFiles(page.messages, this.#options.files),
				cards: await cards.during(room.key, {
					...(first && (page.more || isStartOver(first))
						? { from: first.at }
						: {}),
					...(beforeId === undefined ? {} : { before: beforeId }),
				}),
				...(reads && nameOf
					? { reads: await readsOf(reads, room.key, self, nameOf) }
					: {}),
				...(cursor === undefined ? {} : { cursor }),
			} satisfies MessagesView);
		}
		if (action === "mode" && method === "PUT" && parts.length === 4) {
			// Only an agent's or group's room has modes; a thread runs no turn of the owner's.
			if (room.readOnly || this.#options.modeSwitches === false)
				throw notFound();
			const owner = await this.#owner(admission);
			const body = await bodyOf(request);
			const change: ModeChange = {};
			for (const name of ["yolo", "longRunning"] as const) {
				const value = body[name];
				if (value === undefined) continue;
				if (typeof value !== "boolean")
					throw bad(`${name} must be true or false.`);
				change[name] = value;
			}
			if (Object.keys(change).length === 0)
				throw bad("Give yolo or longRunning.");
			const mode = await modes.set(room.key, change, owner);
			return json({ mode: { yolo: mode.yolo, longRunning: mode.longRunning } });
		}
		if (action === "start-over" && method === "POST" && parts.length === 4) {
			if (room.readOnly) throw notFound();
			await this.#owner(admission);
			await conversations.startFresh(room.key);
			// The other pages read the room list again: its unread count and last line changed.
			this.#options.changed();
			return json({ ok: true });
		}
		if (
			(action === "folder" || action === "pin") &&
			method === "PUT" &&
			parts.length === 4
		)
			return this.#layout.place(request, room, action, admission);
		if (action === "mute" && method === "PUT" && parts.length === 4) {
			// Only an agent's or group's room has a mute of its own; a thread's posts are its parent's business.
			if (room.readOnly) throw notFound();
			const owner = await this.#owner(admission);
			const { muted } = await bodyOf(request);
			if (typeof muted !== "boolean") throw bad("muted must be true or false.");
			await mutes.set(room.key, muted, owner.principalId);
			// The other pages and devices read the room list again to show the bell.
			this.#options.changed();
			return json({ muted });
		}
		throw new HttpError(404, "There is no such API.");
	}

	/**
	 * A page of the conversation a start-over line of the room ended, read only: its messages and
	 * the cards that opened within it. A line that is not one of the room's start-overs names none.
	 */
	async #archived(
		room: ChannelKey,
		until: number,
		before: number | undefined,
		count: number,
	): Promise<MessagesView> {
		const { log, cards } = this.#options;
		const line = await log.get(room, until);
		if (!line || !isStartOver(line)) throw notFound();
		const page = await log.page(room, before, count, until);
		const first = page.messages[0];
		const previous = page.more ? undefined : await log.startOver(room, until);
		const from = page.more
			? first?.at
			: previous === undefined
				? undefined
				: (await log.get(room, previous))?.at;
		return {
			...page,
			messages: withExpiredFiles(page.messages, this.#options.files),
			cards: await cards.during(room, {
				...(from === undefined ? {} : { from }),
				before: before ?? until,
			}),
		};
	}

	/**
	 * Reads the person's rooms up to their newest message in one call: the named ones, or every room
	 * the list shows. A room they may not read is passed over as if it were not named. With `restore`
	 * instead, the cursors a call moved go back, where the person has not read on since.
	 */
	async #readAll(
		request: Request,
		admission: Authenticated,
	): Promise<Response> {
		const { host } = this.#options;
		if (!host) throw new HttpError(404, "There is no such API.");
		const viewer = viewerOf(admission.visitor);
		const body = await bodyOf(request);
		if (body.restore !== undefined) {
			const { restore } = body;
			if (
				!Array.isArray(restore) ||
				restore.length > MAX_BULK_ROOMS ||
				!restore.every(isReadMove)
			)
				throw bad("restore must be a list of at most 500 moves.");
			const restored = await host.unreadAll(viewer, restore);
			if (restored.length) this.#options.changed();
			return json({ restored } satisfies ReadAllUndone);
		}
		const named = await this.#named(body.rooms);
		const keys =
			named ?? (await this.#options.rooms.list()).map((one) => one.key);
		const moved = await host.readAll(viewer, keys);
		if (moved.length) this.#options.changed();
		return json({
			moved: moved.map(({ room, from, to }) => ({ room, from, to })),
		} satisfies ReadAllView);
	}

	/** Takes every finished thread under the named rooms, or under every room the list shows, off the list. */
	async #dismissAllFinished(
		request: Request,
		admission: Authenticated,
	): Promise<Response> {
		await this.#owner(admission);
		const { rooms, threads, surface } = this.#options;
		const named = await this.#named((await bodyOf(request)).rooms);
		const listed = named ?? (await rooms.list()).map((one) => one.key);
		const parents: string[] = [];
		for (const key of new Set(listed)) {
			const one = await rooms.resolve(key);
			if (one && one.kind !== "thread") parents.push(one.key);
		}
		const dismissed = await threads.dismissFinishedUnder(parents);
		const byParent: Record<string, string[]> = {};
		for (const { id, parent } of dismissed)
			byParent[parent] = [
				...(byParent[parent] ?? []),
				channelKey(surface.surface, id),
			];
		if (dismissed.length) this.#options.changed();
		return json({
			dismissed: dismissed.length,
			threads: byParent,
		} satisfies ThreadsDismissedAll);
	}

	/** The room keys a bulk body names; undefined when it names none, meaning every room. */
	async #named(value: unknown): Promise<string[] | undefined> {
		if (value === undefined) return undefined;
		if (
			!Array.isArray(value) ||
			value.length > MAX_BULK_ROOMS ||
			!value.every((one) => typeof one === "string" && one.length <= 300)
		)
			throw bad("rooms must be a list of at most 500 keys.");
		return value;
	}

	/** Takes one finished thread off the room list for every owner; an open one is refused. */
	async #dismiss(
		room: ResolvedRoom,
		admission: Authenticated,
	): Promise<Response> {
		if (room.kind !== "thread") throw notFound();
		await this.#owner(admission);
		const outcome = await this.#options.threads.dismiss(room.name);
		if (outcome === "missing") throw notFound();
		if (outcome === "open")
			throw new HttpError(409, "The thread is still open.");
		this.#options.changed();
		return json({ dismissed: 1 } satisfies ThreadsDismissed);
	}

	/** Takes every finished thread of a room off the room list; the open ones stay. */
	async #dismissFinished(
		room: ResolvedRoom,
		admission: Authenticated,
	): Promise<Response> {
		if (room.kind === "thread") throw notFound();
		await this.#owner(admission);
		const dismissed = await this.#options.threads.dismissFinished(room.key);
		if (dismissed) this.#options.changed();
		return json({ dismissed } satisfies ThreadsDismissed);
	}

	/** Puts one dismissed thread back on the room list for every owner: the undo of a dismissal. */
	async #restore(
		room: ResolvedRoom,
		admission: Authenticated,
	): Promise<Response> {
		if (room.kind !== "thread") throw notFound();
		await this.#owner(admission);
		const outcome = await this.#options.threads.restore(room.name);
		if (outcome === "missing") throw notFound();
		this.#options.changed();
		return json({ restored: 1 } satisfies ThreadsRestored);
	}

	/** Puts back the threads of a room that one clear-all dismissed, named by their keys. */
	async #restoreFinished(
		room: ResolvedRoom,
		request: Request,
		admission: Authenticated,
	): Promise<Response> {
		if (room.kind === "thread") throw notFound();
		await this.#owner(admission);
		const { threads } = await bodyOf(request);
		if (
			!Array.isArray(threads) ||
			threads.length > MAX_RESTORED ||
			!threads.every((one) => typeof one === "string")
		)
			throw bad("threads must be a list of at most 100 keys.");
		// A key is `<surface>:<thread id>`; the store knows the id.
		const ids = threads.map((key: string) => key.slice(key.indexOf(":") + 1));
		const restored = await this.#options.threads.restoreFinished(room.key, ids);
		if (restored) this.#options.changed();
		return json({ restored } satisfies ThreadsRestored);
	}

	async #file(id: string, admission: Authenticated): Promise<Response> {
		if (!isFileId(id)) throw notFound();
		const { files, host } = this.#options;
		// A file bound to a host room or page is for the people it is open to, owners too; every other stored file belongs to an agent room, which only owners read.
		const bound = files.binding(id)?.room;
		if (bound === undefined) {
			if (admission.visitor.tier !== "owner") throw notFound();
		} else if (
			!host ||
			!(await host.mayRead(viewerOf(admission.visitor), bound))
		)
			throw notFound();
		const meta = files.meta(id);
		const blob = files.blob(id);
		if (!meta || !blob) throw notFound();
		return fileResponse(meta, blob);
	}

	/** The workspace files pane's API; every call, a read too, is an owner's. */
	async #workspace(
		request: Request,
		parts: string[],
		admission: Authenticated,
	): Promise<Response> {
		const files = this.#options.workspace;
		if (!files) throw new HttpError(404, "This pane is not served.");
		const owner = await this.#owner(admission);
		return files.speaking(owner.id, () =>
			this.#workspaceCall(request, parts, files, owner.id),
		);
	}

	async #workspaceCall(
		request: Request,
		parts: string[],
		files: WorkspaceFiles,
		by: string,
	): Promise<Response> {
		const { method } = request;
		const [, , rootId, action, trashId, trashAction] = parts;
		const params = new URL(request.url).searchParams;
		const path = params.get("path") ?? "";
		try {
			if (!rootId) {
				if (method !== "GET") throw new HttpError(405, "Method not allowed.");
				return json({ roots: files.roots() } satisfies WorkspaceRootsView);
			}
			if (action === "list" && method === "GET" && parts.length === 4)
				return json(await files.list(rootId, path));
			if (action === "raw" && method === "GET" && parts.length === 4)
				return await files.raw(rootId, path, params.get("download") === "1", {
					range: request.headers.get("range"),
					ifRange: request.headers.get("if-range"),
					ifNoneMatch: request.headers.get("if-none-match"),
				});
			if (action === "file" && parts.length === 4) {
				if (method === "GET") return json(await files.read(rootId, path));
				if (method === "PUT") {
					const body = await bodyOf(request, EDIT_MAX_BYTES * 2 + 4096);
					const { text, baseHash } = body;
					if (typeof text !== "string") throw bad("text must be text.");
					if (typeof baseHash !== "string" || !/^[0-9a-f]{64}$/.test(baseHash))
						throw bad("baseHash must be the hash the file was read with.");
					const save: WorkspaceSave = { text, baseHash };
					return json(await files.save(rootId, path, save, by));
				}
			}
			if (action === "new" && method === "POST" && parts.length === 4) {
				const body = await bodyOf(request, EDIT_MAX_BYTES * 2 + 4096);
				const { kind, text } = body;
				if (kind !== "file" && kind !== "dir")
					throw bad("kind must be file or dir.");
				if (text !== undefined && typeof text !== "string")
					throw bad("text must be text.");
				const made: WorkspaceNew = {
					kind,
					...(text === undefined ? {} : { text }),
				};
				return json(await files.create(rootId, path, made, by), 201);
			}
			if (action === "rename" && method === "POST" && parts.length === 4) {
				const body = await bodyOf(request);
				const { from, to } = body;
				if (typeof from !== "string" || typeof to !== "string")
					throw bad("from and to must be paths.");
				const moved: WorkspaceRename = { from, to };
				await files.rename(rootId, moved.from, moved.to, by);
				return json({ ok: true });
			}
			if (action === "entry" && method === "DELETE" && parts.length === 4)
				return json(await files.remove(rootId, path, by));
			if (action === "trash") {
				if (method === "GET" && !trashId)
					return json(await files.trash(rootId));
				if (
					method === "POST" &&
					trashId &&
					trashAction === "restore" &&
					parts.length === 6
				)
					return json(await files.restore(rootId, trashId, by));
				if (method === "DELETE" && trashId && !trashAction) {
					await files.purge(rootId, trashId, by);
					return json({ ok: true });
				}
			}
		} catch (error) {
			if (error instanceof WorkspaceRefusal) {
				const refused = refusalOf(error);
				return json(
					{
						error: refused.message,
						reason: error.reason,
					} satisfies WorkspaceRefusalBody,
					refused.status,
				);
			}
			if (error instanceof WorkspaceConflictError) {
				const refused = conflictOf(error);
				return json(
					{
						error: refused.message,
						conflict: error.conflict,
						...(error.current ? { current: error.current } : {}),
					} satisfies WorkspaceConflict,
					409,
				);
			}
			throw error;
		}
		throw new HttpError(404, "There is no such API.");
	}

	/** Whether a schedule is the visitor's own: its creator id names their principal. */
	async #ownSchedule(
		createdById: string,
		principalId: string,
	): Promise<boolean> {
		if (createdById === principalId) return true;
		// A schedule from 0.8 names its creator by a user id that the backfill made a principal's id.
		return (
			(await this.#options.identity.principal(createdById))?.id === principalId
		);
	}

	async #schedules(
		method: string,
		id: string | undefined,
		admission: Authenticated,
	): Promise<Response> {
		const { schedules, rooms } = this.#options;
		if (!schedules) throw new HttpError(404, "This pane is not served.");
		const { tier, principal } = admission.visitor;
		const owner = tier === "owner";
		if (method === "GET" && !id) {
			const all = await schedules.all();
			const views: ScheduleView[] = [];
			for (const schedule of all) {
				// The owners see every schedule; anyone else sees their own, and no room of the owners.
				if (
					!owner &&
					!(await this.#ownSchedule(schedule.createdById, principal.id))
				)
					continue;
				const room = owner ? await rooms.resolve(schedule.channel) : undefined;
				views.push({
					id: schedule.id,
					...(room ? { room: room.key } : {}),
					channel: schedule.channel,
					label: room?.displayName ?? schedule.channel,
					title: schedule.title,
					prompt: schedule.prompt,
					recurrence: schedule.recurrence,
					nextRun: schedule.nextRun.toISOString(),
					...(schedule.lastRun
						? { lastRun: schedule.lastRun.toISOString() }
						: {}),
					...(schedule.lastStatus ? { lastStatus: schedule.lastStatus } : {}),
					createdBy: schedule.createdByName,
				});
			}
			return json({ schedules: views } satisfies SchedulesView);
		}
		if (method === "DELETE" && id) {
			const number = Number(id);
			if (!Number.isInteger(number)) throw bad("The schedule id is a number.");
			// Another person's schedule is not there to remove, for anyone but the owners.
			if (!owner) {
				const found = await schedules.get(number);
				if (
					!found ||
					!(await this.#ownSchedule(found.createdById, principal.id))
				)
					throw new HttpError(404, "There is no such schedule.");
			}
			const removed = await schedules.remove(number);
			if (!removed) throw new HttpError(404, "There is no such schedule.");
			this.#options.changed();
			return json({ ok: true });
		}
		throw new HttpError(405, "Method not allowed.");
	}
}
