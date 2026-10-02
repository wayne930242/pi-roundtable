import { coding } from "../src/index.ts";

/** Add this plugin to the host's roundtable.config.ts plugins list. */
export const codingDesk = coding({
	shelfDir: "/srv/roundtable/repos",
	model: "anthropic/claude-sonnet-4-6",
	thinking: "medium",
	timeoutMs: 3_600_000,
	ownerRepos: [],
});
