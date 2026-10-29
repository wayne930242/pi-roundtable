import type { CharacterInput } from "pi-roundtable/characters";
import type {
	AgentPatch,
	AgentProfileView,
	ApiError,
	CharacterRefusal,
	CharacterRequest,
	ConfigView,
	ConnectorsView,
	ConversationsView,
	LayoutView,
	MessagesView,
	ModelsView,
	NoteInput,
	NoteView,
	OverviewView,
	PrincipalsView,
	PushDevicesView,
	PushKeyView,
	RoomMode,
	RoomsView,
	SchedulesView,
	SessionView,
	SkillDetailView,
	SkillView,
	TranscriptView,
	UploadView,
} from "../../src/api-types.ts";

import { receivedCharacter } from "./character-spec.ts";
import { type Kit, loadKit } from "./kit.ts";
import { translate as t } from "./messages.ts";

// The page is served at `<mount>/`, so these relative URLs reach `<mount>/api/`.
const API = "api/";

/** An error the API answered, with the field it names when the refusal is about one. */
export class ApiFailure extends Error {
	readonly field: string | undefined;
	/** The HTTP status the API answered. */
	readonly status: number | undefined;
	/** The error body, for a caller that reads more than the message (a conflict names the file as it is now). */
	readonly body: unknown;
	constructor(
		message: string,
		field?: string,
		status?: number,
		body?: unknown,
	) {
		super(message);
		this.name = "ApiFailure";
		this.field = field;
		this.status = status;
		this.body = body;
	}
}

const serverText = (text: string | undefined): string | undefined =>
	text === undefined ? undefined : t(text);

export async function request<T>(
	path: string,
	init: RequestInit = {},
): Promise<T> {
	let response: Response;
	try {
		response = await fetch(`${API}${path}`, {
			...init,
			headers: {
				// A form sets its own content type, with the boundary.
				...(init.body && !(init.body instanceof FormData)
					? { "content-type": "application/json" }
					: {}),
				...init.headers,
			},
		});
	} catch {
		// An expired proxy session may redirect to a login page, which fetch cannot follow.
		throw new Error(
			t("The console is unreachable. Reload the page to sign in again."),
		);
	}
	const body: unknown = await response.json().catch(() => undefined);
	// A 403 from the app's own API names its reason (a file in a read-only place, a link out of the
	// workspace); one without is the sign-in's.
	if (
		response.status === 403 &&
		typeof (body as { reason?: unknown } | undefined)?.reason !== "string"
	)
		throw new Error(
			t("The request was refused. Reload the page to sign in again."),
		);
	if (!response.ok)
		throw new ApiFailure(
			// The app's API words its refusals in English; the console's arrive in the host's wording already.
			serverText((body as ApiError | undefined)?.error) ??
				t("The console answered {status}.", { status: response.status }),
			(body as Partial<CharacterRefusal> | undefined)?.field,
			response.status,
			body,
		);
	return body as T;
}

export const api = {
	config: () => request<ConfigView>("config"),
	skills: () => request<SkillView[]>("skills"),
	skill: (name: string) =>
		request<SkillDetailView>(`skills/${encodeURIComponent(name)}`),
	connectors: () => request<ConnectorsView>("connectors"),
	startOver: (key: string) =>
		request<{ kind: string }>(
			`channels/${encodeURIComponent(key)}/start-over`,
			{ method: "POST" },
		),
	deleteConversation: (key: string) =>
		request<{ result: string }>(`channels/${encodeURIComponent(key)}/delete`, {
			method: "POST",
		}),
	overview: () => request<OverviewView>("overview"),
	conversations: () => request<ConversationsView>("conversations"),
	transcript: (key: string, archive?: string) =>
		request<TranscriptView>(
			`conversations/${encodeURIComponent(key)}${
				archive ? `?archive=${encodeURIComponent(archive)}` : ""
			}`,
		),
	principals: () => request<PrincipalsView>("principals"),
	notes: (query: string, principal?: string) =>
		request<NoteView[]>(`notes${whose(principal, query ? { q: query } : {})}`),
	addNote: (note: NoteInput, principal?: string) =>
		request<NoteView>(`notes${whose(principal)}`, {
			method: "POST",
			body: JSON.stringify(note),
		}),
	updateNote: (id: number, note: NoteInput, principal?: string) =>
		request<NoteView>(`notes/${id}${whose(principal)}`, {
			method: "PATCH",
			body: JSON.stringify(note),
		}),
	deleteNote: (id: number, principal?: string) =>
		request<{ deleted: number }>(`notes/${id}${whose(principal)}`, {
			method: "DELETE",
		}),
	// The owner app
	session: () => request<SessionView>("session"),
	rooms: async () => {
		const [view, kit] = await Promise.all([
			request<RoomsView>("rooms"),
			loadKitOrNone(),
		]);
		return {
			...view,
			rooms: view.rooms.map((room) =>
				room.character === undefined
					? room
					: kit === undefined
						? withoutCharacter(room)
						: {
								...room,
								character: receivedCharacter(kit, room.character, {
									name: room.name,
									displayName: room.displayName,
								}),
							},
			),
		};
	},
	messages: (room: string, before?: number, limit = 50) =>
		request<MessagesView>(
			`rooms/${encodeURIComponent(room)}/messages?limit=${limit}${
				before === undefined ? "" : `&before=${before}`
			}`,
		),
	setMode: (room: string, change: Partial<RoomMode>) =>
		request<{ mode: RoomMode }>(`rooms/${encodeURIComponent(room)}/mode`, {
			method: "PUT",
			body: JSON.stringify(change),
		}),
	/** Mutes or unmutes the push of a room for every owner. */
	setMute: (room: string, muted: boolean) =>
		request<{ muted: boolean }>(`rooms/${encodeURIComponent(room)}/mute`, {
			method: "PUT",
			body: JSON.stringify({ muted }),
		}),
	/** Makes a folder, last in the list; the answer is the whole layout. */
	createFolder: (name: string) =>
		request<LayoutView>("folders", {
			method: "POST",
			body: JSON.stringify({ name }),
		}),
	/** Renames a folder and/or places it before another (`null` = last). */
	changeFolder: (
		id: string,
		change: { name?: string; before?: string | null },
	) =>
		request<LayoutView>(`folders/${encodeURIComponent(id)}`, {
			method: "PATCH",
			body: JSON.stringify(change),
		}),
	deleteFolder: (id: string) =>
		request<LayoutView>(`folders/${encodeURIComponent(id)}`, {
			method: "DELETE",
		}),
	/** Mutes or unmutes the push of every room in a folder; the answer names the rooms it reached. */
	muteFolder: (id: string, muted: boolean) =>
		request<{ muted: boolean; rooms: string[] }>(
			`folders/${encodeURIComponent(id)}/mute`,
			{ method: "PUT", body: JSON.stringify({ muted }) },
		),
	/** Puts a room in a folder before another room of it (`null` = last), or in none with `folder` null. */
	placeRoom: (room: string, folder: string | null, before: string | null) =>
		request<LayoutView>(`rooms/${encodeURIComponent(room)}/folder`, {
			method: "PUT",
			body: JSON.stringify({ folder, before }),
		}),
	/** Pins a room before another pinned room (`null` = last), or unpins it. */
	pinRoom: (room: string, pinned: boolean, before: string | null) =>
		request<LayoutView>(`rooms/${encodeURIComponent(room)}/pin`, {
			method: "PUT",
			body: JSON.stringify({ pinned, before }),
		}),
	startRoomOver: (room: string) =>
		request<{ ok: true }>(`rooms/${encodeURIComponent(room)}/start-over`, {
			method: "POST",
		}),
	upload: (file: File) => {
		const form = new FormData();
		form.set("file", file);
		return request<UploadView>("uploads", { method: "POST", body: form });
	},
	/** Deletes an upload no message has used, so it stops counting against what the person may have waiting. */
	discardUpload: (id: string) =>
		request<{ ok: true }>(`uploads/${encodeURIComponent(id)}`, {
			method: "DELETE",
		}),
	pushKey: () => request<PushKeyView>("push/key"),
	pushDevices: () => request<PushDevicesView>("push/subscriptions"),
	addPushDevice: (subscription: {
		endpoint: string;
		keys: { p256dh: string; auth: string };
		label: string;
	}) =>
		request<{ id: string }>("push/subscriptions", {
			method: "POST",
			body: JSON.stringify(subscription),
		}),
	removePushEndpoint: (endpoint: string) =>
		request<{ ok: true }>("push/subscriptions", {
			method: "DELETE",
			body: JSON.stringify({ endpoint }),
		}),
	removePushDevice: (id: string) =>
		request<{ ok: true }>(`push/subscriptions/${encodeURIComponent(id)}`, {
			method: "DELETE",
		}),
	schedules: () => request<SchedulesView>("schedules"),
	cancelSchedule: (id: number) =>
		request<{ ok: true }>(`schedules/${id}`, { method: "DELETE" }),
	models: () => request<ModelsView>("models"),
	agent: (name: string) =>
		profile(request<AgentProfileView>(`agents/${encodeURIComponent(name)}`)),
	updateAgent: (name: string, patch: AgentPatch) =>
		profile(
			request<AgentProfileView>(`agents/${encodeURIComponent(name)}`, {
				method: "PATCH",
				body: JSON.stringify(patch),
			}),
		),
	/** Dresses the agent; the answer is its profile with the saved character. */
	setCharacter: (name: string, character: CharacterInput) =>
		profile(
			request<AgentProfileView>(
				`agents/${encodeURIComponent(name)}/character`,
				{
					method: "PUT",
					body: JSON.stringify({ character } satisfies CharacterRequest),
				},
			),
		),
};

/** The kit, or none when its chunk failed to load: rooms and profiles then arrive without characters. */
async function loadKitOrNone(): Promise<Kit | undefined> {
	try {
		return await loadKit();
	} catch (failure) {
		console.warn("the character kit failed to load", failure);
		return undefined;
	}
}

/** A room as it arrives when characters cannot be checked: without one. */
function withoutCharacter<T extends { character?: unknown }>(
	room: T,
): Omit<T, "character"> {
	const { character: _character, ...rest } = room;
	return rest;
}

/** A profile whose character has been checked. */
async function profile(
	answer: Promise<AgentProfileView>,
): Promise<AgentProfileView> {
	const [loaded, kit] = await Promise.all([answer, loadKitOrNone()]);
	// Without the kit the profile still loads; its character is then drawn as the fallback disc.
	if (kit === undefined) return loaded;
	return {
		...loaded,
		character: receivedCharacter(kit, loaded.character, {
			name: loaded.name,
			displayName: loaded.displayName,
		}),
	};
}

/** The query naming whose notes a request is about, with any other parameters; none for the visitor's own. */
function whose(
	principal: string | undefined,
	more: Record<string, string> = {},
): string {
	const query = new URLSearchParams({
		...(principal === undefined ? {} : { principal }),
		...more,
	}).toString();
	return query ? `?${query}` : "";
}

export const EVENTS_URL = `${API}events`;

export const messageOf = (failure: unknown): string =>
	failure instanceof Error ? failure.message : String(failure);
