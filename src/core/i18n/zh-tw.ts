import { agentPanelZhTW } from "./agent-panel.ts";
import { cardsZhTW } from "./cards.ts";
import { channelsZhTW } from "./channels.ts";
import { conversationZhTW } from "./conversation.ts";
import { dashboardZhTW } from "./dashboard.ts";
import { discordZhTW } from "./discord.ts";
import type { Messages } from "./en.ts";
import { ownerZhTW } from "./owner.ts";
import { schedulesZhTW } from "./schedules.ts";
import { timeZonesZhTW } from "./time-zones.ts";
import type { CatalogContext } from "./types.ts";

/** The Traditional Chinese catalog. */
export function createZhTW(ctx: CatalogContext): Messages {
	return {
		...cardsZhTW(ctx),
		...ownerZhTW(ctx),
		...schedulesZhTW(ctx),
		...timeZonesZhTW(),
		...agentPanelZhTW(ctx),
		...conversationZhTW(ctx),
		...dashboardZhTW(ctx),
		...channelsZhTW(ctx),
		...discordZhTW(ctx),
	};
}
