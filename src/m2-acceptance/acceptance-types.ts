export interface Listed {
	/** The test file, from the repository root. */
	file: string;
	/** The test as `bun test` prints it: its describe blocks and its name, joined by " > ". */
	test: string;
	/** What the file writes, when the printed name is built from a template. */
	source?: readonly string[];
}

export interface Item {
	section: "6.1" | "6.2" | "6.3" | "6.4" | "6.5";
	item: string;
	tests: readonly Listed[];
	/** Where an item no test of this repository can check is checked, or why part of it does not apply. */
	note?: string;
}

export const t = (file: string, test: string, source?: string[]): Listed => ({
	file,
	test,
	...(source ? { source } : {}),
});

export const BACKFILL = "src/core/identity/identity-backfill.test.ts";
export const MIGRATION = "src/m2-acceptance/migration.test.ts";
export const ISOLATION = "src/m2-acceptance/isolation.test.ts";
export const WEBCHAT_E2E = "packages/webchat/src/principals.e2e.test.ts";
export const WEBCHAT_AB =
	"webchat core principals with a self-built JWKS > A/B have separate memory, schedules and inboxes, and scheduled replies reach only their owner";
export const UPGRADE = "src/cli/upgrade.test.ts";
export const ACCESS = "src/core/config/access.test.ts";
export const CARDS = "src/core/discord/owner-cards-scope.test.ts";
export const BACKGROUND = "src/core/identity/background-identity.test.ts";
export const BACKGROUND_CHECKS = "src/core/routing/background-checks.test.ts";
export const MEMORY_PERSONA = "src/memory-persona-runtime.test.ts";
export const NOTIFY = "src/core/builtin/modules-notify.test.ts";
