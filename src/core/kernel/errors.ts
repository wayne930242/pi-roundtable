/** A plugin that cannot be registered: it adds nothing, or clashes with another. */
export class PluginError extends Error {
	override name = "PluginError";
}

/** A core port read during setup, before the host has linked every plugin's contributions. */
export class NotLinkedError extends Error {
	override name = "NotLinkedError";
}

/** A plugin's migration failed, so the host stops before any plugin is set up. */
export class MigrationError extends Error {
	override name = "MigrationError";
	readonly migration: string;
	constructor(migration: string, cause: unknown) {
		super(`migration ${migration} failed: ${String(cause)}`, { cause });
		this.migration = migration;
	}
}

/** A judge could not answer: its model failed or said something other than the asked JSON. */
export class JudgeError extends Error {
	override name = "JudgeError";
}

/** A provider slot nobody filled, read by a part that needs it. */
export class ProviderError extends Error {
	override name = "ProviderError";
}

/**
 * Work refused because the host is shutting down: once the drain starts, no turn, queue task, or
 * background run starts any more, and what was waiting behind a running one is dropped.
 */
export class HostStoppingError extends Error {
	override name = "HostStoppingError";
	constructor() {
		super(
			"the host is shutting down and starts no new work; try again once it is back",
		);
	}
}
