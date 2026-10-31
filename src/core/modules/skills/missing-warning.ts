import type { Logger } from "../../log.ts";

/**
 * Warns of a carried skill that is missing once per agent and name. The registry is asked what an
 * agent carries on every room open and menu fetch, so a warning each time would only repeat. A
 * skill that came back is forgotten here, and warned of again if it goes.
 */
export class WarnedMissing {
	readonly #logger: Logger;
	readonly #warned = new Set<string>();

	constructor(logger: Logger) {
		this.#logger = logger;
	}

	missing(
		agent: string,
		skills: readonly { name: string; reason: string }[],
	): void {
		const key = (name: string) => `${agent}\0${name}`;
		const now = new Set(skills.map((skill) => key(skill.name)));
		for (const warned of this.#warned)
			if (warned.startsWith(`${agent}\0`) && !now.has(warned))
				this.#warned.delete(warned);
		for (const { name, reason } of skills) {
			if (this.#warned.has(key(name))) continue;
			this.#warned.add(key(name));
			this.#logger.warn(
				{ agent, skill: name, reason },
				"carried skill missing",
			);
		}
	}
}
