import type { CatalogContext } from "./types.ts";

/** The owner's root command, the stop button, and the failure line of an interaction. */
export function ownerEn(ctx: CatalogContext) {
	return {
		ownerRootDescription: `${ctx.assistant} control panel (owner only)`,
		ownerFailedTitle: "Could not complete",
		ownerErrorTitle: "Something went wrong",
		ownerErrorBody:
			"That did not finish; try again later. The details are in the log.",
		ownerRefusalTitle: "Owner only",
		ownerRefusalBody: `\`/${ctx.root}\` is the control panel of ${ctx.assistant}'s owner.`,
		surfaceActionFailed: "Sorry, that action did not work.",
		stopNote: "-# Working; press Stop to interrupt.",
		stopLabel: "Stop",
		stopDone: "Stopped.",
		stopIdle: "Nothing is running right now.",
		stopOwnerOnly: `Only ${ctx.assistant}'s owner can stop it.`,
		panelPage: (title: string, page: number, pages: number) =>
			`${title} (${page}/${pages})`,
	};
}

export function ownerZhTW(ctx: CatalogContext): ReturnType<typeof ownerEn> {
	return {
		ownerRootDescription: `${ctx.assistant} 控制台（只有擁有者能用）`,
		ownerFailedTitle: "無法完成",
		ownerErrorTitle: "出了點問題",
		ownerErrorBody: "這次沒能完成，請稍後再試；細節已經記在 log 裡。",
		ownerRefusalTitle: "只有擁有者能用",
		ownerRefusalBody: `\`/${ctx.root}\` 是 ${ctx.assistant} 擁有者的控制台。`,
		surfaceActionFailed: "抱歉，這個操作沒有成功。",
		stopNote: "-# 工作中，想中斷就按停止。",
		stopLabel: "停止",
		stopDone: "已停止。",
		stopIdle: "現在沒有進行中的工作。",
		stopOwnerOnly: `只有 ${ctx.assistant} 的擁有者能停止。`,
		panelPage: (title: string, page: number, pages: number) =>
			`${title}（${page}/${pages}）`,
	};
}
