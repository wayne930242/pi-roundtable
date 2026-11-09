import type { ModeChange, Speaker } from "pi-roundtable";
import { PluginError } from "pi-roundtable";
import { CharacterError } from "pi-roundtable/characters";
import { AgentError } from "pi-roundtable/kit";
import type {
	ApiError,
	CharacterRefusal,
	ModelsView,
	RoomOneView,
	RoomsView,
	SessionView,
} from "../api-types.ts";
import type { Authenticated } from "../auth/authenticator.ts";
import { type ConsolePresentation, message } from "../features.ts";
import { json } from "../http.ts";
import { viewerOf } from "../web-app.ts";
import { bad, bodyOf, HttpError, notFound } from "./api-http.ts";
import { CommandRoutes } from "./command-routes.ts";
import { FileApi } from "./file-routes.ts";
import { HelperRoutes } from "./helper-routes.ts";
import { LayoutRoutes } from "./layout-routes.ts";
import { MessageApi } from "./message-routes.ts";
import { PromptApi } from "./prompt-routes.ts";
import { RoomBulkApi } from "./room-bulk-routes.ts";
import { roomModeOf } from "./rooms.ts";
import type { AppApiOptions } from "./routes-options.ts";
import { ScheduleApi } from "./schedule-routes.ts";
import { SkillDocApi } from "./skill-doc-routes.ts";
import { SkillGroupApi } from "./skill-group-routes.ts";
import { TeamApi } from "./team-routes.ts";
import { UploadRefusal } from "./uploads.ts";
import { WorkspaceApi } from "./workspace-api.ts";

export { zipName } from "./file-routes.ts";
export type { AppApiOptions } from "./routes-options.ts";

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
	readonly #commands: CommandRoutes;
	readonly #prompts: PromptApi | undefined;
	readonly #skillDocs: SkillDocApi | undefined;
	readonly #skillGroups: SkillGroupApi | undefined;
	readonly #messages: MessageApi;
	readonly #bulk: RoomBulkApi;
	readonly #files: FileApi;
	readonly #scheduleApi: ScheduleApi;
	readonly #workspaceApi: WorkspaceApi;

	constructor(options: AppApiOptions) {
		this.#options = options;
		this.#messages = new MessageApi(options);
		this.#bulk = new RoomBulkApi(options, (admission) =>
			this.#owner(admission),
		);
		this.#files = new FileApi(options);
		this.#scheduleApi = new ScheduleApi(options);
		this.#workspaceApi = new WorkspaceApi(options.workspace, (admission) =>
			this.#owner(admission),
		);
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
		this.#commands = new CommandRoutes({
			declared: () => options.chatCommands?.() ?? [],
			...(options.skills?.carried ? { skillsOf: options.skills.carried } : {}),
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
		const skills = options.skills;
		this.#skillGroups = skills
			? new SkillGroupApi({
					groups: skills.groups,
					catalog: () => skills.catalog(),
					attach: (agent, add, remove) => skills.attach(agent, add, remove),
					active: (agent) =>
						options.directory.agent(agent)?.status === "active",
					changed: () => options.changed(),
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
					"presets",
					"models",
					"workspace",
					"prompts",
					"skill-docs",
					"skill-groups",
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
		if (area === "files" && method === "GET" && id === "zip" && !action)
			return await this.#files.messageZip(request, admission);
		if (area === "files" && method === "GET" && id && !action)
			return await this.#files.file(id, admission);
		if (area === "workspace")
			return this.#workspaceApi.handle(request, parts, admission);
		if (area === "schedules")
			return this.#scheduleApi.schedules(method, id, admission);
		const owner = () => this.#owner(admission);
		if (area === "agents") return this.#team.agents(request, parts, owner);
		if (area === "groups") return this.#team.groups(request, parts, owner);
		if ((area === "archive" || area === "presets") && method === "GET" && !id)
			return this.#team.listing(area, owner);
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
		if (area === "skill-groups") {
			if (!this.#skillGroups)
				throw new HttpError(404, "This host has no skills.");
			return this.#skillGroups.handle(request, parts, owner);
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
			...(this.#options.team.helpersOn() ? { helpers: true } : {}),
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
		const { rooms, modes, mutes, conversations } = this.#options;
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
			return this.#bulk.readAll(request, admission);
		if (key === "dismiss-finished-threads" && !action && method === "POST")
			return this.#bulk.dismissAllFinished(request, admission);
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
			// A dismissed thread or a temp knight's room still opens by its address.
			const view =
				(await rooms.threadView(room.key)) ??
				(await rooms.openHelper(room.key));
			if (!view) throw notFound();
			return json({ room: view } satisfies RoomOneView);
		}
		if (action === "commands" && method === "GET" && parts.length === 4)
			return this.#commands.list(room, await this.#owner(admission));
		if (action === "dismiss" && method === "POST" && parts.length === 4)
			return this.#bulk.dismiss(room, admission);
		if (action === "dismiss-threads" && method === "POST" && parts.length === 4)
			return this.#bulk.dismissFinished(room, admission);
		if (action === "undismiss" && method === "POST" && parts.length === 4)
			return this.#bulk.restore(room, admission);
		if (
			action === "undismiss-threads" &&
			method === "POST" &&
			parts.length === 4
		)
			return this.#bulk.restoreFinished(room, request, admission);
		if (action === "messages" && method === "GET" && parts.length === 4)
			return this.#messages.page(request, room, admission);
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
			if (modes.peek(room.key).inheritedFrom)
				throw bad(
					"This room follows the modes of the conversation that made it; switch them there.",
				);
			const mode = await modes.set(room.key, change, owner);
			return json({ mode: roomModeOf(mode) });
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
}
