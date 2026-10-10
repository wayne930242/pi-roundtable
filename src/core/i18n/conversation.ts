import type { CatalogContext } from "./types.ts";

/** Notices, thread lines, and titles a conversation posts on its own. */
export function conversationEn(ctx: CatalogContext) {
	return {
		failureNotice:
			"Sorry, this reply did not go through. Please try again later.",
		stoppedNotice: "-# Stopped.",
		restartingNotice: `-# ${ctx.assistant} is restarting and takes no new messages right now; please send this again in a few minutes.`,
		roundLimitNotice:
			"-# This round already has 8 replies, so it stops here; call us again if you need more.",
		restartNotice: `-# ${ctx.assistant} restarted before this job finished, so nothing more will be reported here.`,
		threadStarted: (name: string, thread: string | undefined) =>
			thread ? `🧵 Started: ${name} → ${thread}` : `🧵 Started: ${name}`,
		delegationTask: (task: string) => `📋 Task:\n${task}`,
		delegationDone: (report: string) => `✅ Done\n\n${report}`,
		delegationFailed: (error: string) => `❌ Failed: ${error}`,
		agentNoReply: (message: string) => `❌ No reply: ${message}`,
		messageDelivered: (displayName: string, text: string) =>
			`📨 To **${displayName}**:\n${text}`,
		answerReturned: (text: string) => `↩️ Reply:\n${text}`,
		thinkingAuto: "auto",
		confirmTitle: (asker: string) => `${asker} wants to run this action`,
		askTitle: (asker: string) => `${asker} has a question for you`,
	};
}

export function conversationZhTW(
	ctx: CatalogContext,
): ReturnType<typeof conversationEn> {
	return {
		failureNotice: "抱歉，這次沒能完成回覆，請稍後再試一次。",
		stoppedNotice: "-# 已停止。",
		restartingNotice: `-# ${ctx.assistant} 正在重新啟動，暫時不接新訊息；請過幾分鐘再傳一次。`,
		roundLimitNotice:
			"-# 這一輪已經有 8 則回覆，先停在這裡；需要的話請再叫我們。",
		restartNotice: `-# ${ctx.assistant} 在這項工作結束前重新啟動了，這裡不會再有回報。`,
		threadStarted: (name: string, thread: string | undefined) =>
			thread ? `🧵 開始：${name} → ${thread}` : `🧵 開始：${name}`,
		delegationTask: (task: string) => `📋 任務：\n${task}`,
		delegationDone: (report: string) => `✅ 完成\n\n${report}`,
		delegationFailed: (error: string) => `❌ 失敗：${error}`,
		agentNoReply: (message: string) => `❌ 沒有回覆：${message}`,
		messageDelivered: (displayName: string, text: string) =>
			`📨 給 **${displayName}**：\n${text}`,
		answerReturned: (text: string) => `↩️ 回覆：\n${text}`,
		thinkingAuto: "自動",
		confirmTitle: (asker: string) => `${asker} 要執行這個動作`,
		askTitle: (asker: string) => `${asker} 想問你`,
	};
}
