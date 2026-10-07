// Error types shared across layers. Each carries the failing component in its name so logs and
// tests can tell them apart without string matching.

export class ConfigError extends Error {
	override name = "ConfigError";
}

export class AgentRunError extends Error {
	override name = "AgentRunError";
}

export class CardRenderError extends Error {
	override name = "CardRenderError";
}

export class MemoryError extends Error {
	override name = "MemoryError";
}

export class ScheduleError extends Error {
	override name = "ScheduleError";
}

export class DelegationError extends Error {
	override name = "DelegationError";
}

/** A request about agents or groups that cannot be met; its message is shown to whoever asked. */
export class AgentError extends Error {
	override name = "AgentError";
}

/** A principal, identity link, or role change that cannot be made; its message names what to fix. */
export class IdentityError extends Error {
	override name = "IdentityError";
}
