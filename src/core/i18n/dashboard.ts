import type { CatalogContext } from "./types.ts";

/** The dashboard message, its channel topic, group topics, and the assistant's webhook name. */
export function dashboardEn(ctx: CatalogContext) {
	return {
		dashTitle: "## Agent server",
		dashUpdated: (time: string) =>
			`-# Updated ${time}; refreshed when a turn starts or ends, at most every 10 seconds`,
		dashGroupsHeading: "### Groups",
		dashContextNone: "context —",
		dashContextCompacted: (limit: string) =>
			`context just compacted, updates next turn (limit ${limit})`,
		dashContext: (tokens: string, limit: string, percent: number) =>
			`context ${tokens} / ${limit} (${percent}%)`,
		dashWorking: (channelId: string, waiting: number) =>
			`🟠 Working (<#${channelId}>)${waiting > 0 ? `, ${waiting} queued` : ""}`,
		dashQueued: (waiting: number) => `🟡 ${waiting} queued`,
		dashIdle: "🟢 Idle",
		dashLastActive: (time: string) => `Last active ${time}`,
		dashNotActive: "No activity since startup",
		dashAgentFooter: (schedules: number, last: string) =>
			`-# Schedules ${schedules} · ${last}`,
		dashGroupBusy: (busy: number) => `🟠 ${busy} in progress`,
		dashGroupMembers: (members: readonly string[], host: string) =>
			`Members: ${members.join(", ")} | Host: ${host}`,
		dashMore: (count: number) => `-# ${count} more not listed.`,
		dashNone: "-# None.",
		dashTopic: `Status of ${ctx.assistant}'s agent server; this message updates itself.`,
		groupTopic: (
			displayName: string,
			members: readonly string[],
			host: string,
		) => `${displayName} | Members: ${members.join(", ")} | Host: ${host}`,
		webhookName: `${ctx.assistant} agents`,
	};
}

export function dashboardZhTW(
	ctx: CatalogContext,
): ReturnType<typeof dashboardEn> {
	return {
		dashTitle: "## Agent 伺服器",
		dashUpdated: (time: string) =>
			`-# 更新於 ${time}；回合開始、結束時更新，最快每 10 秒一次`,
		dashGroupsHeading: "### 群組",
		dashContextNone: "context —",
		dashContextCompacted: (limit: string) =>
			`context 剛壓縮，下一回合更新（上限 ${limit}）`,
		dashContext: (tokens: string, limit: string, percent: number) =>
			`context ${tokens} / ${limit}（${percent}%）`,
		dashWorking: (channelId: string, waiting: number) =>
			`🟠 工作中（<#${channelId}>）${waiting > 0 ? `，排隊 ${waiting}` : ""}`,
		dashQueued: (waiting: number) => `🟡 排隊 ${waiting}`,
		dashIdle: "🟢 閒置",
		dashLastActive: (time: string) => `最後活動 ${time}`,
		dashNotActive: "啟動後尚未活動",
		dashAgentFooter: (schedules: number, last: string) =>
			`-# 排程 ${schedules} · ${last}`,
		dashGroupBusy: (busy: number) => `🟠 進行中（${busy} 則）`,
		dashGroupMembers: (members: readonly string[], host: string) =>
			`成員：${members.join("、")}｜主持：${host}`,
		dashMore: (count: number) => `-# 還有 ${count} 項沒列出。`,
		dashNone: "-# 沒有。",
		dashTopic: `${ctx.assistant} 的 agent 伺服器狀態，這則訊息會自動更新。`,
		groupTopic: (
			displayName: string,
			members: readonly string[],
			host: string,
		) => `${displayName}｜成員：${members.join("、")}｜主持：${host}`,
		webhookName: `${ctx.assistant} agents`,
	};
}
