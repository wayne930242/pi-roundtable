import type { SkillRegistry } from "pi-roundtable";
import type {
	SkillGroupApplied,
	SkillGroupApply,
	SkillGroupChanged,
	SkillGroupSave,
	SkillGroupsView,
	SkillView,
} from "../api-types.ts";
import { json } from "../http.ts";
import {
	bad,
	bodyOf,
	HttpError,
	optionalList,
	optionalText,
	requiredText,
} from "./api-http.ts";
import type { OwnerOf } from "./team-routes.ts";

export interface SkillGroupApiOptions {
	groups: Pick<SkillRegistry, "groups" | "setGroup" | "deleteGroup">;
	/** The catalog the page lists: who carries each skill, and which are built in. */
	catalog(): SkillView[];
	/** The same change the per-skill toggle makes. */
	attach(
		agent: string,
		add: readonly string[],
		remove: readonly string[],
	): Promise<string[]>;
	/** Whether a knight answers; an archived or unknown one is a 404. */
	active(agent: string): boolean;
	changed(): void;
}

/**
 * The app's REST for skill groups: listing them, creating or replacing one, deleting one, and
 * applying one to a knight. Applying switches on the group's skills the knight lacks through the
 * per-skill toggle's path and switches nothing off; the knight carries skills, not the group.
 * Every call is an owner's; the registry's refusals are a 400 in its words.
 */
export class SkillGroupApi {
	readonly #options: SkillGroupApiOptions;

	constructor(options: SkillGroupApiOptions) {
		this.#options = options;
	}

	async handle(
		request: Request,
		parts: string[],
		owner: OwnerOf,
	): Promise<Response> {
		const { method } = request;
		const [, , name, action] = parts;
		const { groups } = this.#options;
		// The tier is read first, so a person below the owner learns of no group.
		await owner();
		if (!name) {
			if (method !== "GET") throw new HttpError(405, "Method not allowed.");
			return json({
				groups: groups.groups().map(({ name, description, skills }) => ({
					name,
					description,
					skills: [...skills],
				})),
			} satisfies SkillGroupsView);
		}
		const group = groups.groups().find((one) => one.name === name);
		if (!action && method === "PUT") {
			const body = await bodyOf(request);
			const from = optionalText(body, "from");
			const save: SkillGroupSave = {
				description: requiredText(body, "description"),
				skills: optionalList(body, "skills") ?? [],
				...(from ? { from } : {}),
			};
			const renamed = save.from !== undefined && save.from !== name;
			if (renamed) {
				if (!groups.groups().some((one) => one.name === save.from))
					throw new HttpError(404, "There is no such skill group.");
				if (group) throw bad(`There is already a skill group "${name}".`);
			}
			let message = await groups.setGroup(name, save.description, save.skills);
			if (renamed && save.from)
				message = `${message} ${await groups.deleteGroup(save.from)}`;
			this.#options.changed();
			return json({ message } satisfies SkillGroupChanged, group ? 200 : 201);
		}
		if (!group) throw new HttpError(404, "There is no such skill group.");
		if (!action && method === "DELETE") {
			const message = await groups.deleteGroup(name);
			this.#options.changed();
			return json({ message } satisfies SkillGroupChanged);
		}
		if (action === "apply" && method === "POST" && parts.length === 4) {
			const body = await bodyOf(request);
			const apply: SkillGroupApply = { agent: requiredText(body, "agent") };
			if (!this.#options.active(apply.agent))
				throw new HttpError(404, "There is no such room, knight or file.");
			const catalog = new Map(
				this.#options.catalog().map((entry) => [entry.name, entry]),
			);
			// A built-in skill is carried already; a carried one stays as it is.
			const added = group.skills.filter((skill) => {
				const entry = catalog.get(skill);
				return !(
					entry?.source.kind === "builtin" ||
					entry?.carriers.includes(apply.agent)
				);
			});
			if (added.length > 0) {
				await this.#options.attach(apply.agent, added, []);
				this.#options.changed();
			}
			return json({ added } satisfies SkillGroupApplied);
		}
		throw new HttpError(404, "There is no such API.");
	}
}
