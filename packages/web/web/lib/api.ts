import type {
	AgentPatch,
	AgentProfileView,
	ApiError,
	ConfigView,
	ConnectorsView,
	ConversationsView,
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

import { translate as t } from "./messages.ts";

// The page is served at `<mount>/`, so these relative URLs reach `<mount>/api/`.
const API = "api/";

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
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
	if (response.status === 403)
		throw new Error(
			t("The request was refused. Reload the page to sign in again."),
		);
	const body: unknown = await response.json().catch(() => undefined);
	if (!response.ok)
		throw new Error(
			(body as ApiError | undefined)?.error ??
				t("The console answered {status}.", { status: response.status }),
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
	rooms: () => request<RoomsView>("rooms"),
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
		request<AgentProfileView>(`agents/${encodeURIComponent(name)}`),
	updateAgent: (name: string, patch: AgentPatch) =>
		request<AgentProfileView>(`agents/${encodeURIComponent(name)}`, {
			method: "PATCH",
			body: JSON.stringify(patch),
		}),
};

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
