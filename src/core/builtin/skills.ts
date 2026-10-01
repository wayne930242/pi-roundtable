import type { SQL } from "bun";
import { StoredSkillRegistry } from "../modules/skills/skill-registry.ts";
import { SkillStore } from "../modules/skills/skill-store.ts";
import {
	SKILL_LIST_TOOL,
	SKILL_TOOLS,
	skillToolsExtension,
} from "../modules/skills/skill-tools.ts";
import type { RoundtablePlugin } from "../plugin.ts";
import { AGENTS, SKILLS } from "../services.ts";
import type { Tier } from "../speakers.ts";
import { agentOnly } from "./session-tool.ts";

export interface SkillsOptions {
	/** The guild whose agents' skills the store keeps. */
	guildId: string;
	/** Where the registry reads and writes skills. */
	reposDir: string;
	writtenDir: string;
	builtinDir: string;
}

/** Admins manage skills; every speaker may look one up. */
const SKILL_TIERS: Readonly<Record<string, Tier>> = {
	...Object.fromEntries(SKILL_TOOLS.map((tool) => [tool, "admin" as const])),
	[SKILL_LIST_TOOL]: "member",
};

/**
 * The skills agents carry: the tables, the registry provided as `SKILLS`, and the skill tools of
 * agent sessions. An addon; `skills: false` leaves it out, and agents carry none.
 */
export function skillsPlugin(
	options: SkillsOptions,
	/** Opens the store; a test hands a stand-in, so the plugin can be set up without a database. */
	openStore: (sql: SQL, guildId: string) => Promise<SkillStore> = (
		sql,
		guildId,
	) => SkillStore.attach(sql, guildId),
): RoundtablePlugin {
	let registry: StoredSkillRegistry | undefined;
	return {
		name: "skills",
		migrations: SkillStore.migrations(options.guildId),
		provides: [SKILLS],
		// The skills are read once every plugin is set up, so a plugin may still place some in setup.
		preflight: () => registry?.init(),
		setup: async ({ database, services, logger }) => {
			const built = new StoredSkillRegistry({
				store: await openStore(database(), options.guildId),
				reposDir: options.reposDir,
				writtenDir: options.writtenDir,
				builtinDir: options.builtinDir,
				logger,
			});
			registry = built;
			services.provide(SKILLS, built);
			return {
				sessionTools: [
					agentOnly("skill-tools", () =>
						skillToolsExtension(built, (name) => {
							// The agent server is set up after this plugin and read when a session is built.
							services.get(AGENTS).directory.activeAgent(name);
						}),
					),
				],
				agentSelection: () => ({ tools: SKILL_TOOLS, groups: [] }),
				toolTiers: SKILL_TIERS,
			};
		},
	};
}
