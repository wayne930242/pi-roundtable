import type { SQL } from "bun";
import type { Logger } from "../log.ts";
import { PgPromptDocuments } from "../modules/prompts/prompt-documents.ts";
import type { RoundtablePlugin } from "../plugin.ts";
import { PROMPTS } from "../services.ts";

export interface PromptsOptions {
	/** The guild whose overrides the documents keep, or the local team's id. */
	guildId: string;
}

/**
 * The prompt texts the owner edits in the app: the tables, the documents provided as `PROMPTS`
 * (the agent server's and the plugins' registered during their setup), and one warning per
 * document that differs from its file version, said once every plugin has registered.
 */
export function promptsPlugin(
	options: PromptsOptions,
	/** Opens the documents; a test hands stand-ins, so the plugin can be set up without a database. */
	open: (sql: SQL, guildId: string) => Promise<PgPromptDocuments> = (
		sql,
		guildId,
	) => PgPromptDocuments.attach(sql, guildId),
): RoundtablePlugin {
	let opened: { documents: PgPromptDocuments; logger: Logger } | undefined;
	return {
		name: "prompts",
		migrations: PgPromptDocuments.migrations(),
		provides: [PROMPTS],
		preflight: () => opened?.documents.logOverrides(opened.logger),
		setup: async ({ database, services, logger }) => {
			const documents = await open(database(), options.guildId);
			opened = { documents, logger };
			services.provide(PROMPTS, documents);
			return {};
		},
	};
}
