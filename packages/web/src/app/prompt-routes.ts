import type {
	PromptDocuments,
	PromptDocumentView,
	PromptVersion,
} from "pi-roundtable";
import type {
	PromptConflict,
	PromptHistoryView,
	PromptSave,
	PromptsView,
	PromptVersionView,
	PromptView,
} from "../api-types.ts";
import { json } from "../http.ts";
import { bad, bodyOf, HttpError } from "./api-http.ts";
import type { OwnerOf } from "./team-routes.ts";

/** The largest body of a save: a document of 20,000 characters may be four bytes each. */
const MAX_PROMPT_BYTES = 128 * 1024;

export interface PromptApiOptions {
	prompts: Pick<PromptDocuments, "list" | "get" | "set" | "revert" | "history">;
}

const viewOf = (document: PromptDocumentView): PromptView => ({
	id: document.id,
	label: document.label,
	...(document.description ? { description: document.description } : {}),
	differs: document.differs,
	...(document.override
		? {
				override: {
					by: document.override.by,
					at: document.override.at.toISOString(),
				},
			}
		: {}),
	text: document.text,
	fileText: document.fileText,
	maxChars: document.maxChars,
});

export const promptVersionView = (
	version: PromptVersion,
): PromptVersionView => ({
	id: version.id,
	action: version.action,
	text: version.text,
	previous: version.previous,
	by: version.by,
	at: version.at.toISOString(),
});

/**
 * The app's REST for the prompt documents: the main prompts the owner edits outside the files.
 * Every call, a read too, is an owner's (the tier read again); a write is also checked for the
 * console's `Origin` before it gets here. A save names the text it was edited from, and a document
 * that changed meanwhile answers 409 with what is there now.
 */
export class PromptApi {
	readonly #options: PromptApiOptions;

	constructor(options: PromptApiOptions) {
		this.#options = options;
	}

	async handle(
		request: Request,
		parts: string[],
		owner: OwnerOf,
	): Promise<Response> {
		const { method } = request;
		const [, , id, action] = parts;
		const { prompts } = this.#options;
		if (!id) {
			if (method !== "GET") throw new HttpError(405, "Method not allowed.");
			await owner();
			return json({
				documents: prompts
					.list()
					.map(({ differs, id: key, label, description, override }) => ({
						id: key,
						label,
						...(description ? { description } : {}),
						differs,
						...(override
							? { override: { by: override.by, at: override.at.toISOString() } }
							: {}),
					})),
			} satisfies PromptsView);
		}
		const document = prompts.get(id);
		if (!document) throw new HttpError(404, "There is no such prompt.");
		if (!action && method === "GET") {
			await owner();
			return json(viewOf(document));
		}
		if (!action && method === "PUT") {
			const speaker = await owner();
			const body = await bodyOf(request, MAX_PROMPT_BYTES);
			const { text, base } = body;
			if (typeof text !== "string") throw bad("text must be text.");
			if (typeof base !== "string")
				throw bad("base must be the text the prompt was edited from.");
			const save: PromptSave = { text, base };
			if (document.text !== save.base) {
				const refused = new HttpError(
					409,
					"This prompt changed while you were editing it.",
				);
				return json(
					{
						error: refused.message,
						conflict: "changed",
						current: viewOf(document),
					} satisfies PromptConflict,
					refused.status,
				);
			}
			return json(viewOf(await prompts.set(id, save.text, speaker.name)));
		}
		if (action === "revert" && method === "POST" && parts.length === 4) {
			const speaker = await owner();
			return json(viewOf(await prompts.revert(id, speaker.name)));
		}
		if (action === "history" && method === "GET" && parts.length === 4) {
			await owner();
			return json({
				versions: (await prompts.history(id)).map(promptVersionView),
			} satisfies PromptHistoryView);
		}
		throw new HttpError(404, "There is no such API.");
	}
}
