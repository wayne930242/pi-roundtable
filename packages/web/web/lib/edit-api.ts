// The calls that edit prompts and skills. They live apart from `api.ts` because only the pages and
// sheets that edit make them, and those load when first opened.

import type {
	PromptHistoryView,
	PromptRevert,
	PromptSave,
	PromptsView,
	PromptView,
	SkillDeleted,
	SkillDocCreate,
	SkillDocSave,
	SkillDocView,
	SkillGroupApplied,
	SkillGroupChanged,
	SkillGroupSave,
	SkillGroupsView,
	SkillHistoryView,
} from "../../src/api-types.ts";
import { request } from "./api.ts";

const send = <T>(path: string, method: string, body?: unknown) =>
	request<T>(path, {
		method,
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});

const named = (name: string) => encodeURIComponent(name);

export const editApi = {
	/** The changes of an agent's prompt, newest first. */
	agentPromptHistory: (name: string) =>
		request<PromptHistoryView>(`agents/${named(name)}/prompt-history`),
	prompts: () => request<PromptsView>("prompts"),
	prompt: (id: string) => request<PromptView>(`prompts/${named(id)}`),
	savePrompt: (id: string, save: PromptSave) =>
		send<PromptView>(`prompts/${named(id)}`, "PUT", save),
	revertPrompt: (id: string, revert: PromptRevert) =>
		send<PromptView>(`prompts/${named(id)}/revert`, "POST", revert),
	promptHistory: (id: string) =>
		request<PromptHistoryView>(`prompts/${named(id)}/history`),
	skillDocument: (name: string) =>
		request<SkillDocView>(`skill-docs/${named(name)}`),
	saveSkillDocument: (name: string, save: SkillDocSave) =>
		send<SkillDocView>(`skill-docs/${named(name)}`, "PUT", save),
	createSkillDocument: (made: SkillDocCreate) =>
		send<SkillDocView>("skill-docs", "POST", made),
	/** Deletes an agent-written skill and detaches it from every knight and group that carries it. */
	deleteSkillDocument: (name: string) =>
		send<SkillDeleted>(`skill-docs/${named(name)}`, "DELETE"),
	skillHistory: (name: string) =>
		request<SkillHistoryView>(`skill-docs/${named(name)}/history`),
	skillGroups: () => request<SkillGroupsView>("skill-groups"),
	/** Creates or replaces a group; `from` renames the group it names. */
	saveSkillGroup: (name: string, save: SkillGroupSave) =>
		send<SkillGroupChanged>(`skill-groups/${named(name)}`, "PUT", save),
	/** Deletes a group; its skills and their carriers stay as they are. */
	deleteSkillGroup: (name: string) =>
		send<SkillGroupChanged>(`skill-groups/${named(name)}`, "DELETE"),
	/** Switches on the group's skills a knight lacks; nothing is switched off. */
	applySkillGroup: (name: string, agent: string, on = true) =>
		send<SkillGroupApplied>(`skill-groups/${named(name)}/apply`, "POST", {
			agent,
			on,
		}),
};
