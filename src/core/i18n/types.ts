/** What every catalog factory knows about the deployment it speaks for. */
export interface CatalogContext {
	/** The assistant's display name, such as "Roundtable". */
	assistant: string;
	/** The name of the root slash command, without the slash. */
	root: string;
}
