import type { SkillDocument, SkillRegistry } from "pi-roundtable";
import { SkillConflictError } from "pi-roundtable";
import type {
	SkillConflict,
	SkillDocCreate,
	SkillDocSave,
	SkillDocView,
	SkillHistoryView,
	SkillView,
} from "../api-types.ts";
import { json } from "../http.ts";
import { bad, bodyOf, HttpError } from "./api-http.ts";
import type { OwnerOf } from "./team-routes.ts";

/** The largest body of a save: a SKILL.md of 12,000 characters may be four bytes each, with its frontmatter. */
const MAX_SKILL_BYTES = 64 * 1024;

export interface SkillDocApiOptions {
	skills: Pick<
		SkillRegistry,
		"document" | "saveDocument" | "createDocument" | "documentHistory"
	>;
	/** The catalog the page lists, so a name it does not list is a 404 before the registry is asked. */
	catalog(): SkillView[];
}

const viewOf = (document: SkillDocument): SkillDocView => ({
	name: document.name,
	source: document.source,
	text: document.text,
	hash: document.hash,
	writable: document.writable,
});

/**
 * The app's REST for a skill's SKILL.md: reading it whole, saving an agent-written skill's, making a
 * skill and listing the versions kept. The frontmatter rules are the skill tools': the registry
 * checks them, and a refusal is a 400 with its words. Every call is an owner's; a save names the
 * hash it was edited from, and a skill that changed meanwhile answers 409 with what is there now.
 */
export class SkillDocApi {
	readonly #options: SkillDocApiOptions;

	constructor(options: SkillDocApiOptions) {
		this.#options = options;
	}

	async handle(
		request: Request,
		parts: string[],
		owner: OwnerOf,
	): Promise<Response> {
		const { method } = request;
		const [, , name, action] = parts;
		const { skills } = this.#options;
		if (!name) {
			if (method !== "POST") throw new HttpError(405, "Method not allowed.");
			const speaker = await owner();
			const body = await bodyOf(request, MAX_SKILL_BYTES);
			if (typeof body.text !== "string") throw bad("text must be text.");
			const made: SkillDocCreate = { text: body.text };
			return json(
				viewOf(await skills.createDocument(made.text, speaker.name)),
				201,
			);
		}
		if (!this.#options.catalog().some((skill) => skill.name === name))
			throw new HttpError(404, "There is no such skill.");
		if (!action && method === "GET") {
			await owner();
			return json(viewOf(await skills.document(name)));
		}
		if (!action && method === "PUT") {
			const speaker = await owner();
			const body = await bodyOf(request, MAX_SKILL_BYTES);
			const { text, baseHash } = body;
			if (typeof text !== "string") throw bad("text must be text.");
			if (typeof baseHash !== "string" || !/^[0-9a-f]{64}$/.test(baseHash))
				throw bad("baseHash must be the hash the skill was read with.");
			const save: SkillDocSave = { text, baseHash };
			try {
				return json(
					viewOf(
						await skills.saveDocument(
							name,
							save.text,
							save.baseHash,
							speaker.name,
						),
					),
				);
			} catch (error) {
				if (error instanceof SkillConflictError)
					return json(
						{
							error: "This skill changed while you were editing it.",
							conflict: "changed",
							current: viewOf(error.current),
						} satisfies SkillConflict,
						409,
					);
				throw error;
			}
		}
		if (action === "history" && method === "GET" && parts.length === 4) {
			await owner();
			return json({
				versions: (await skills.documentHistory(name)).map((version) => ({
					id: version.id,
					text: version.text,
					hash: version.hash,
					by: version.by,
					at: version.at.toISOString(),
				})),
			} satisfies SkillHistoryView);
		}
		throw new HttpError(404, "There is no such API.");
	}
}
