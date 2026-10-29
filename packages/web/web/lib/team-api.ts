// The calls that change the team. They live apart from `api.ts` because only the team's sheets make
// them, and those load when first opened.

import type {
	AgentCreate,
	AgentProfileView,
	AgentSkillsChange,
	AgentSkillsView,
	ArchiveView,
	GroupCreate,
	GroupPatch,
	GroupProfileView,
} from "../../src/api-types.ts";
import { api, request } from "./api.ts";
import { store } from "./app-store.ts";

const send = <T>(path: string, method: string, body?: unknown) =>
	request<T>(path, {
		method,
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});

const named = (name: string) => encodeURIComponent(name);

export const teamApi = {
	createAgent: (made: AgentCreate) =>
		send<AgentProfileView>("agents", "POST", made),
	archiveAgent: (name: string) =>
		send<{ ok: true }>(`agents/${named(name)}/archive`, "POST"),
	restoreAgent: (name: string) =>
		send<AgentProfileView>(`agents/${named(name)}/restore`, "POST"),
	deleteAgent: (name: string) =>
		send<{ ok: true }>(`agents/${named(name)}`, "DELETE"),
	skills: (name: string) =>
		request<AgentSkillsView>(`agents/${named(name)}/skills`),
	setSkills: (name: string, change: AgentSkillsChange) =>
		send<AgentSkillsView>(`agents/${named(name)}/skills`, "PUT", change),
	archive: () => request<ArchiveView>("archive"),
	createGroup: (made: GroupCreate) =>
		send<GroupProfileView>("groups", "POST", made),
	group: (name: string) => request<GroupProfileView>(`groups/${named(name)}`),
	updateGroup: (name: string, patch: GroupPatch) =>
		send<GroupProfileView>(`groups/${named(name)}`, "PATCH", patch),
	archiveGroup: (name: string) =>
		send<{ ok: true }>(`groups/${named(name)}/archive`, "POST"),
	restoreGroup: (name: string) =>
		send<GroupProfileView>(`groups/${named(name)}/restore`, "POST"),
	deleteGroup: (name: string) =>
		send<{ ok: true }>(`groups/${named(name)}`, "DELETE"),
};

/** Reads the room list again now, so a room just made, archived or restored is in the store before the page goes to it. */
export async function refreshRooms(): Promise<void> {
	const view = await api.rooms();
	store.dispatch({ type: "rooms_loaded", rooms: view.rooms });
}
