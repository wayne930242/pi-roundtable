import type {
	ApiError,
	ConfigView,
	ConversationsView,
	NoteInput,
	NoteView,
	OverviewView,
	TranscriptView,
} from "../../src/api-types.ts";

// The page is served at `<mount>/`, so these relative URLs reach `<mount>/api/`.
const API = "api/";

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
	let response: Response;
	try {
		response = await fetch(`${API}${path}`, {
			...init,
			headers: {
				...(init.body ? { "content-type": "application/json" } : {}),
				...init.headers,
			},
		});
	} catch {
		// An expired proxy session may redirect to a login page, which fetch cannot follow.
		throw new Error(
			"The console is unreachable. Reload the page to sign in again.",
		);
	}
	if (response.status === 403)
		throw new Error(
			"The request was refused. Reload the page to sign in again.",
		);
	const body: unknown = await response.json().catch(() => undefined);
	if (!response.ok)
		throw new Error(
			(body as ApiError | undefined)?.error ??
				`The console answered ${response.status}.`,
		);
	return body as T;
}

export const api = {
	config: () => request<ConfigView>("config"),
	overview: () => request<OverviewView>("overview"),
	conversations: () => request<ConversationsView>("conversations"),
	transcript: (key: string, archive?: string) =>
		request<TranscriptView>(
			`conversations/${encodeURIComponent(key)}${
				archive ? `?archive=${encodeURIComponent(archive)}` : ""
			}`,
		),
	notes: (query: string) =>
		request<NoteView[]>(
			query ? `notes?q=${encodeURIComponent(query)}` : "notes",
		),
	addNote: (note: NoteInput) =>
		request<NoteView>("notes", { method: "POST", body: JSON.stringify(note) }),
	updateNote: (id: number, note: NoteInput) =>
		request<NoteView>(`notes/${id}`, {
			method: "PATCH",
			body: JSON.stringify(note),
		}),
	deleteNote: (id: number) =>
		request<{ deleted: number }>(`notes/${id}`, { method: "DELETE" }),
};

export const EVENTS_URL = `${API}events`;

export const messageOf = (failure: unknown): string =>
	failure instanceof Error ? failure.message : String(failure);
