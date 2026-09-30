import type { CatalogContext } from "./types.ts";

/**
 * Audit-log reasons and the refusals of the owner's Discord tools. They read as English in both
 * locales: the audit log and the tools' answers are read by the owner and the model alike.
 */
export function discordEn(ctx: CatalogContext) {
	return {
		auditArranged: `${ctx.assistant} arranged the agent channels`,
		auditArchived: `${ctx.assistant} archived this channel's agent or group`,
		auditWebhook: `${ctx.assistant} agents speak here`,
		auditRequested: (ownerName: string) =>
			`${ctx.assistant}, at ${ownerName}'s request`,
		refuseNotInServer: `${ctx.assistant} is not in that server`,
		refuseNotVisible: `not a server channel ${ctx.assistant} can see`,
		refuseAssistantLacks: (names: string) =>
			`${ctx.assistant} lacks ${names} there`,
	};
}

export function discordZhTW(ctx: CatalogContext): ReturnType<typeof discordEn> {
	return discordEn(ctx);
}
