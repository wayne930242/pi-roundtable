import type { BackgroundTarget } from "../../contract/channels.ts";
import { messages } from "../../i18n/index.ts";

/**
 * The host's own background target: every person's conversations whose claim answers background
 * turns, such as the owner's and the agent server's on Discord. The modules plugin contributes it
 * on every host, so schedules and delegated tasks made there carry its name and limits; its name
 * stays "owner", as 0.8 stored it. Its label is read when a list is shown, never when this module
 * loads, because the host applies its catalog at startup.
 */
export const PERSONAL_TARGET: BackgroundTarget = {
	name: "owner",
	label: () => messages().scheduleModeOwner,
	schedules: { perChannel: 20, promptChars: 8_000, aheadDays: 366 },
	delegation: { maxRunning: 3 },
};
