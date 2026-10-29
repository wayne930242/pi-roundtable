import type {
	PromptDocuments,
	PromptDocumentView,
	PromptVersion,
} from "pi-roundtable";
import { PromptConflictError } from "pi-roundtable";
import type {
	PromptConflict,
	PromptHistoryView,
	PromptRevert,
	PromptSave,
	PromptsView,
	PromptVersionView,
	PromptView,
} from "../api-types.ts";
import { json } from "../http.ts";
import { bad, bodyOf, HttpError } from "./api-http.ts";
import type { OwnerOf } from "./team-routes.ts";

/** The most bytes a character takes in a JSON body: a control character is escaped as `\u00XX`. */
const BYTES_PER_CHAR = 6;
/** What a body carries besides the texts: the braces, the keys and some room. */
const BODY_OVERHEAD = 4 * 1024;

/**
 * The largest body of a write to a document: the new text, at most `maxChars` characters, and
 * `base`, the text in force when the edit began, which may be longer (a file version has no limit).
 */
const bodyLimit = (document: PromptDocumentView): number =>
	(Math.max(document.maxChars, document.text.length, document.fileText.length) +
		document.maxChars) *
		BYTES_PER_CHAR +
	BODY_OVERHEAD;

export interface PromptApiOptions {
	prompts: Pick<PromptDocuments, "list" | "get" | "set" | "revert" | "history">;
}

const viewOf = (document: PromptDocumentView): PromptView => ({
	id: document.id,
	label: document.label,
	...(document.description ? { description: document.description } : {}),
	differs: document.differs,
	...(document.broken ? { broken: document.broken } : {}),
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

/** The answer to a write, or 409 with the document as it is now when it was not the text the writer saw. */
async function changed(
	write: () => Promise<PromptDocumentView>,
): Promise<Response> {
	try {
		return json(viewOf(await write()));
	} catch (error) {
		if (!(error instanceof PromptConflictError)) throw error;
		const refused = new HttpError(
			409,
			"This prompt changed while you were editing it.",
		);
		return json(
			{
				error: refused.message,
				conflict: "changed",
				current: viewOf(error.current),
			} satisfies PromptConflict,
			refused.status,
		);
	}
}

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
					.map(
						({ differs, id: key, label, description, override, broken }) => ({
							id: key,
							label,
							...(description ? { description } : {}),
							differs,
							...(broken ? { broken } : {}),
							...(override
								? {
										override: {
											by: override.by,
											at: override.at.toISOString(),
										},
									}
								: {}),
						}),
					),
			} satisfies PromptsView);
		}
		// The tier is read before the id is looked up, so a person below the owner learns of no id.
		const speaker = await owner();
		const document = prompts.get(id);
		if (!document) throw new HttpError(404, "There is no such prompt.");
		if (!action && method === "GET") return json(viewOf(document));
		if (!action && method === "PUT") {
			const body = await bodyOf(request, bodyLimit(document));
			const { text, base } = body;
			if (typeof text !== "string") throw bad("text must be text.");
			if (typeof base !== "string")
				throw bad("base must be the text the prompt was edited from.");
			const save: PromptSave = { text, base };
			// The registry compares `base` where the write waits its turn, so two saves cannot both pass.
			return changed(() => prompts.set(id, save.text, speaker.name, save.base));
		}
		if (action === "revert" && method === "POST" && parts.length === 4) {
			const body = await bodyOf(request, bodyLimit(document));
			if (typeof body.base !== "string")
				throw bad("base must be the text the prompt was reverted from.");
			const revert: PromptRevert = { base: body.base };
			return changed(() => prompts.revert(id, speaker.name, revert.base));
		}
		if (action === "history" && method === "GET" && parts.length === 4) {
			return json({
				versions: (await prompts.history(id)).map(promptVersionView),
			} satisfies PromptHistoryView);
		}
		throw new HttpError(404, "There is no such API.");
	}
}
