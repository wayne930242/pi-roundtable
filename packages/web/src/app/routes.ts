import type {
	AgentChange,
	AgentDirectory,
	AgentTeam,
	AvatarStudio,
	ConversationModes,
	ConversationPort,
	IdentityService,
	Logger,
	ModeChange,
	ScheduleStore,
	Speaker,
} from "pi-roundtable";
import { characterOf, PluginError } from "pi-roundtable";
import { CharacterError, resolveCharacter } from "pi-roundtable/characters";
import { AgentError } from "pi-roundtable/kit";
import type {
	AgentPatch,
	AgentProfileView,
	ApiError,
	CharacterRefusal,
	CharacterRequest,
	MessagesView,
	ModelsView,
	RoomsView,
	SchedulesView,
	ScheduleView,
	SessionView,
} from "../api-types.ts";
import type { Authenticated } from "../auth/authenticator.ts";
import { json } from "../http.ts";
import type { PushMutes } from "../push/mutes.ts";
import { readLimited } from "../request-body.ts";
import type { CardLog } from "./card-log.ts";
import { type FileDir, fileResponse, isFileId } from "./files.ts";
import { PAGE_LIMIT, type RoomLog } from "./room-log.ts";
import type { Rooms } from "./rooms.ts";
import type { AppSurface } from "./surface.ts";
import { UploadRefusal, type Uploads } from "./uploads.ts";

/** The largest JSON body a write reads: 64 KiB. */
const MAX_BODY_BYTES = 64 * 1024;
/** The largest body of a character write: 4 KiB. */
const MAX_CHARACTER_BYTES = 4 * 1024;

export interface AppApiOptions {
	surface: AppSurface;
	rooms: Rooms;
	log: RoomLog;
	cards: CardLog;
	uploads: Uploads;
	/** Where stored files are read from. */
	files: FileDir;
	modes: Pick<ConversationModes, "set" | "peek">;
	/** The rooms whose push the owners muted. */
	mutes: Pick<PushMutes, "set">;
	conversations: Pick<ConversationPort, "startFresh">;
	identity: Pick<IdentityService, "tierOf">;
	/** Present when the schedules pane is served. */
	schedules?: Pick<ScheduleStore, "all" | "remove">;
	directory: Pick<AgentDirectory, "agent">;
	team: Pick<
		AgentTeam,
		"update" | "dress" | "usableModels" | "modelOf" | "defaultModel"
	>;
	avatars: Pick<AvatarStudio, "serve">;
	/** The mount, which a room's agent picture hangs under. */
	mount: string;
	/** How the console signs the person in, as the session reports it. */
	authMode: SessionView["auth"];
	/** The quiet hours of push, as the settings page shows them. */
	quietHours?: NonNullable<SessionView["quietHours"]>;
	/** Called after a change the other pages should refetch. */
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

const bad = (message: string) => new HttpError(400, message);
const notFound = () =>
	new HttpError(404, "There is no such room, agent or file.");

/** The parts of a path under the mount, each decoded; undefined for one that is not valid. */
export function partsOf(path: string): string[] | undefined {
	try {
		return path.split("/").filter(Boolean).map(decodeURIComponent);
	} catch {
		return undefined;
	}
}

async function bodyOf(
	request: Request,
	limit = MAX_BODY_BYTES,
): Promise<Record<string, unknown>> {
	const raw = await readLimited(request, limit);
	if (!raw) throw new HttpError(413, "The body is too large.");
	let value: unknown;
	try {
		value = JSON.parse(raw.toString("utf8"));
	} catch {
		throw bad("The body is not JSON.");
	}
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw bad("The body is not an object.");
	return value as Record<string, unknown>;
}

const optionalText = (
	body: Record<string, unknown>,
	key: string,
): string | undefined => {
	const value = body[key];
	if (value === undefined) return undefined;
	if (typeof value !== "string") throw bad(`${key} must be text.`);
	return value;
};

/**
 * The owner app's REST under `<mount>/api/` and `<mount>/avatars/`. Every route is behind the
 * authenticator, which also checks the `Origin` of a write; a write also reads the person's tier
 * again. A room in a path is one of the app's rooms or the answer is 404, so no other surface's
 * key is ever read or changed here.
 */
export class AppApi {
	readonly #options: AppApiOptions;

	constructor(options: AppApiOptions) {
		this.#options = options;
	}

	/** Answers a path of the app's, or undefined for any other. `rest` is what follows the mount. */
	async handle(
		request: Request,
		rest: string,
		admission: Authenticated,
	): Promise<Response | undefined> {
		const parts = partsOf(rest);
		if (!parts) return undefined;
		const [first, second] = parts;
		const mine =
			(first === "avatars" && parts.length === 2) ||
			(first === "api" &&
				[
					"session",
					"rooms",
					"uploads",
					"files",
					"schedules",
					"agents",
					"models",
				].includes(second ?? ""));
		if (!mine) return undefined;
		try {
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

	/** The owner who writes: their tier read again, as a speaker for the calls that need one. */
	async #owner(admission: Authenticated): Promise<Speaker> {
		const { principal } = admission.visitor;
		const tier = await this.#options.identity.tierOf(principal.id);
		if (tier !== "owner")
			throw new HttpError(403, "Only an owner may do this.");
		return {
			id: admission.actor
				? `${admission.actor.provider}:${admission.actor.subject}`
				: principal.id,
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
		if (area === "session" && method === "GET") return this.#session(admission);
		if (area === "models" && method === "GET")
			return json({
				models: await this.#options.team.usableModels(),
			} satisfies ModelsView);
		if (area === "rooms") return this.#rooms(request, parts, admission);
		if (area === "uploads" && method === "POST" && !id) {
			const owner = await this.#owner(admission);
			return json(
				await this.#options.uploads.receive(request, owner.principalId),
			);
		}
		if (area === "uploads" && method === "DELETE" && id && !action) {
			const owner = await this.#owner(admission);
			if (!this.#options.uploads.discard(id, owner.principalId))
				throw notFound();
			return json({ ok: true });
		}
		if (area === "files" && method === "GET" && id && !action)
			return this.#file(id);
		if (area === "schedules") return this.#schedules(method, id, admission);
		if (area === "agents" && id)
			return this.#agent(request, id, action, admission);
		throw new HttpError(404, "There is no such API.");
	}

	#session(admission: Authenticated): Response {
		const { principal } = admission.visitor;
		return json({
			principal: { id: principal.id, name: principal.displayName },
			surface: this.#options.surface.surface,
			auth: this.#options.authMode,
			push: true,
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
		if (!key) {
			if (method !== "GET") throw new HttpError(405, "Method not allowed.");
			return json({ rooms: await rooms.list() } satisfies RoomsView);
		}
		const room = await rooms.resolve(key);
		if (!room) throw notFound();
		if (action === "messages" && method === "GET" && parts.length === 4) {
			const params = new URL(request.url).searchParams;
			const before = params.get("before");
			const limit = params.get("limit");
			const beforeId = before === null ? undefined : Number(before);
			const count = limit === null ? PAGE_LIMIT : Number(limit);
			if (
				(beforeId !== undefined && !Number.isInteger(beforeId)) ||
				!Number.isInteger(count) ||
				count < 1
			)
				throw bad("before and limit must be whole numbers.");
			const page = await log.page(room.key, beforeId, count);
			// The cards stand among the messages by the time they opened; a page that has older
			// messages leaves the cards before its first one to the older page.
			const first = page.messages[0];
			return json({
				...page,
				cards: await cards.during(room.key, {
					...(page.more && first ? { from: first.at } : {}),
					...(beforeId === undefined ? {} : { before: beforeId }),
				}),
			} satisfies MessagesView);
		}
		if (action === "mode" && method === "PUT" && parts.length === 4) {
			// Only an agent's or group's room has modes; a thread runs no turn of the owner's.
			if (room.readOnly) throw notFound();
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
			return json({ ok: true });
		}
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

	#file(id: string): Response {
		if (!isFileId(id)) throw notFound();
		const meta = this.#options.files.meta(id);
		const blob = this.#options.files.blob(id);
		if (!meta || !blob) throw notFound();
		return fileResponse(meta, blob);
	}

	async #schedules(
		method: string,
		id: string | undefined,
		admission: Authenticated,
	): Promise<Response> {
		const { schedules, rooms } = this.#options;
		if (!schedules) throw new HttpError(404, "This pane is not served.");
		if (method === "GET" && !id) {
			const all = await schedules.all();
			const views: ScheduleView[] = [];
			for (const schedule of all) {
				const room = await rooms.resolve(schedule.channel);
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
			await this.#owner(admission);
			const number = Number(id);
			if (!Number.isInteger(number)) throw bad("The schedule id is a number.");
			const removed = await schedules.remove(number);
			if (!removed) throw new HttpError(404, "There is no such schedule.");
			this.#options.changed();
			return json({ ok: true });
		}
		throw new HttpError(405, "Method not allowed.");
	}

	async #agent(
		request: Request,
		name: string,
		action: string | undefined,
		admission: Authenticated,
	): Promise<Response> {
		const { directory, team } = this.#options;
		const agent = directory.agent(name);
		if (agent?.status !== "active") throw notFound();
		if (!action && request.method === "GET") return json(this.#profile(name));
		if (!action && request.method === "PATCH") {
			await this.#owner(admission);
			const body = await bodyOf(request);
			const patch: AgentPatch = {};
			for (const key of [
				"displayName",
				"prompt",
				"model",
				"thinking",
			] as const) {
				const value = optionalText(body, key);
				if (value !== undefined) patch[key] = value;
			}
			const change: AgentChange = patch;
			await team.update(name, change);
			this.#options.changed();
			return json(this.#profile(name));
		}
		if (action === "character" && request.method === "PUT") {
			await this.#owner(admission);
			const body = await bodyOf(request, MAX_CHARACTER_BYTES);
			const { character } = body;
			if (
				typeof character !== "object" ||
				character === null ||
				Array.isArray(character)
			)
				throw bad("character must be an object.");
			const asked: CharacterRequest = {
				character: character as CharacterRequest["character"],
			};
			// `dress` words a refusal as an agent error; checking here first names the field.
			resolveCharacter(asked.character, characterOf(agent));
			await team.dress(name, asked.character);
			this.#options.changed();
			return json(this.#profile(name));
		}
		throw new HttpError(404, "There is no such API.");
	}

	#profile(name: string): AgentProfileView {
		const { directory, team, rooms, surface } = this.#options;
		const agent = directory.agent(name);
		if (!agent) throw notFound();
		const effective = team.modelOf(name);
		return {
			name: agent.name,
			displayName: agent.displayName,
			prompt: agent.prompt,
			...(agent.model ? { model: agent.model } : {}),
			...(agent.thinking ? { thinking: agent.thinking } : {}),
			effective: {
				model: effective.model,
				thinking: String(effective.thinking),
			},
			avatar: rooms.avatarOf(agent),
			character: characterOf(agent),
			room: `${surface.surface}:agent.${agent.name}`,
		};
	}
}
