// The calls that edit prompts and skills. They live apart from `api.ts` because only the pages and
// sheets that edit make them, and those load when first opened.

import type {
	PromptHistoryView,
	PromptSave,
	PromptsView,
	PromptView,
	SkillDocCreate,
	SkillDocSave,
	SkillDocView,
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
	revertPrompt: (id: string) =>
		send<PromptView>(`prompts/${named(id)}/revert`, "POST"),
	promptHistory: (id: string) =>
		request<PromptHistoryView>(`prompts/${named(id)}/history`),
	skillDocument: (name: string) =>
		request<SkillDocView>(`skill-docs/${named(name)}`),
	saveSkillDocument: (name: string, save: SkillDocSave) =>
		send<SkillDocView>(`skill-docs/${named(name)}`, "PUT", save),
	createSkillDocument: (made: SkillDocCreate) =>
		send<SkillDocView>("skill-docs", "POST", made),
	skillHistory: (name: string) =>
		request<SkillHistoryView>(`skill-docs/${named(name)}/history`),
};
