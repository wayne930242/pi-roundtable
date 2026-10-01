import type { CatalogContext } from "./types.ts";

const WEEKDAYS_ZH: Record<string, string> = {
	sun: "日",
	mon: "一",
	tue: "二",
	wed: "三",
	thu: "四",
	fri: "五",
	sat: "六",
};

const WEEKDAYS_EN: Record<string, string> = {
	sun: "Sun",
	mon: "Mon",
	tue: "Tue",
	wed: "Wed",
	thu: "Thu",
	fri: "Fri",
	sat: "Sat",
};

/** The schedule panel, the schedule slash commands, and how a recurrence reads. */
export function schedulesEn(ctx: CatalogContext) {
	return {
		scheduleWeekday: (day: string) => WEEKDAYS_EN[day] ?? day,
		scheduleOnce: (date: string, time: string) => `Once on ${date} at ${time}`,
		scheduleDaily: (time: string) => `Daily at ${time}`,
		scheduleEveryDays: (days: number, time: string, startDate: string) =>
			`Every ${days} days at ${time} (counting from ${startDate})`,
		scheduleWeekly: (days: readonly string[], time: string) =>
			`Weekly on ${days.join(", ")} at ${time}`,
		scheduleHead: (
			id: number,
			title: string,
			channel: string,
			target: string,
		) => `**#${id} ${title}** · ${channel} · ${target}`,
		scheduleModeOwner: ctx.assistant,
		scheduleFooter: `Schedules are created and edited by the bot in conversation; here you can review and cancel them. \`/${ctx.root} schedule cancel\` cancels one.`,
		scheduleGroupDescription: "Schedules",
		scheduleListDescription: "List the schedules of every channel",
		scheduleCancelDescription: "Cancel a schedule",
		scheduleIdDescription: "The schedule to cancel",
		scheduleLastRun: (unix: number, status: string) =>
			`; last run <t:${unix}:R> (${status})`,
		scheduleNextRun: (recurrence: string, unix: number) =>
			`${recurrence}; next run <t:${unix}:f>`,
		scheduleSetBy: (name: string, lastRun: string) =>
			`Set by ${name}${lastRun}`,
		scheduleChoice: (id: number, title: string, recurrence: string) =>
			`#${id} ${title} (${recurrence})`,
		scheduleTitle: "Schedules",
		scheduleNone: "No schedules right now.",
		schedulePickOne: "Pick a schedule from the list.",
		scheduleUnknown: (id: string) => `There is no schedule #${id}.`,
		scheduleCancelled: "Schedule cancelled",
	};
}

export function schedulesZhTW(
	ctx: CatalogContext,
): ReturnType<typeof schedulesEn> {
	return {
		scheduleWeekday: (day: string) => WEEKDAYS_ZH[day] ?? day,
		scheduleOnce: (date: string, time: string) => `單次 ${date} ${time}`,
		scheduleDaily: (time: string) => `每天 ${time}`,
		scheduleEveryDays: (days: number, time: string, startDate: string) =>
			`每 ${days} 天 ${time}（從 ${startDate} 起算）`,
		scheduleWeekly: (days: readonly string[], time: string) =>
			`每週${days.join("、")} ${time}`,
		scheduleHead: (
			id: number,
			title: string,
			channel: string,
			target: string,
		) => `**#${id} ${title}**　${channel}　${target}`,
		scheduleModeOwner: ctx.assistant,
		scheduleFooter: `排程由 bot 在對話中建立與修改；這裡可以總覽與取消。\`/${ctx.root} schedule cancel\` 取消。`,
		scheduleGroupDescription: "排程",
		scheduleListDescription: "列出所有頻道的排程",
		scheduleCancelDescription: "取消一個排程",
		scheduleIdDescription: "要取消的排程",
		scheduleLastRun: (unix: number, status: string) =>
			`；上次 <t:${unix}:R>（${status}）`,
		scheduleNextRun: (recurrence: string, unix: number) =>
			`${recurrence}；下次 <t:${unix}:f>`,
		scheduleSetBy: (name: string, lastRun: string) =>
			`由 ${name} 設定${lastRun}`,
		scheduleChoice: (id: number, title: string, recurrence: string) =>
			`#${id} ${title}（${recurrence}）`,
		scheduleTitle: "排程",
		scheduleNone: "目前沒有排程。",
		schedulePickOne: "請從清單選一個排程。",
		scheduleUnknown: (id: string) => `沒有 #${id} 這個排程。`,
		scheduleCancelled: "排程已取消",
	};
}
