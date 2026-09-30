import { agentPanelEn } from "./agent-panel.ts";
import { cardsEn } from "./cards.ts";
import { channelsEn } from "./channels.ts";
import { conversationEn } from "./conversation.ts";
import { dashboardEn } from "./dashboard.ts";
import { discordEn } from "./discord.ts";
import { ownerEn } from "./owner.ts";
import { schedulesEn } from "./schedules.ts";
import { timeZonesEn } from "./time-zones.ts";
import type { CatalogContext } from "./types.ts";

export type Messages = ReturnType<typeof createEn>;

/** The English catalog, the package's default. */
export function createEn(ctx: CatalogContext) {
	return {
		...cardsEn(ctx),
		...ownerEn(ctx),
		...schedulesEn(ctx),
		...timeZonesEn(),
		...agentPanelEn(ctx),
		...conversationEn(ctx),
		...dashboardEn(ctx),
		...channelsEn(ctx),
		...discordEn(ctx),
	};
}
