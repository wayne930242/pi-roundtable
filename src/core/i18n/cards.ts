import type { CatalogContext } from "./types.ts";

/** The owner's approval and question cards. */
export function cardsEn(ctx: CatalogContext) {
	return {
		cardRunLabel: "Run",
		cardCancelLabel: "Cancel",
		cardApprovalFooter:
			"If nobody answers within 30 minutes, it falls back to waiting for your confirmation in text.",
		cardQuestionFooter: "Valid for 30 minutes.",
		cardStopped: "⏹️ This round was stopped.",
		cardExpired: "⌛ Timed out with no answer.",
		cardOwnerOnly: `Only ${ctx.assistant}'s owner can answer this card.`,
		cardApproversNote: (minTier: string) =>
			`-# Who can approve: ${minTier} and above`,
		cardApproversRefusal: (minTier: string) =>
			`This card needs ${minTier} or above to answer.`,
		cardAskerNote: (userId: string) => `-# Who can answer: <@${userId}>`,
		cardAskerRefusal: "This question is for another speaker.",
		cardInactive: `This card is no longer active (it timed out, or ${ctx.assistant} restarted); reply in text if you need to.`,
		cardApproved: "✅ Approved to run.",
		cardDeclined: "❌ Cancelled.",
		cardAnswerLabel: "Answer…",
		cardOtherLabel: "Other…",
		cardOtherDescription: "Write your own answer",
		cardPickManyPlaceholder: "Pick as many as you like",
		cardPickOnePlaceholder: "Pick one",
		cardModalTitle: "Answer",
		cardModalField: "Your answer",
		cardQuote: (text: string) => `“${text}”`,
		cardAnswered: (parts: readonly string[]) =>
			`Answered: ${parts.join(", ").slice(0, 300)}`,
	};
}

export function cardsZhTW(ctx: CatalogContext): ReturnType<typeof cardsEn> {
	return {
		cardRunLabel: "執行",
		cardCancelLabel: "取消",
		cardApprovalFooter: "30 分鐘內沒回覆，就改成等你用文字確認。",
		cardQuestionFooter: "30 分鐘內有效。",
		cardStopped: "⏹️ 這一輪已停止。",
		cardExpired: "⌛ 已逾時，沒有回答。",
		cardOwnerOnly: `只有 ${ctx.assistant} 的擁有者能回答這張卡片。`,
		cardApproversNote: (minTier: string) => `-# 可以核准的人：${minTier} 以上`,
		cardApproversRefusal: (minTier: string) =>
			`這張卡片要 ${minTier} 以上才能回答。`,
		cardAskerNote: (userId: string) => `-# 可以回答的人：<@${userId}>`,
		cardAskerRefusal: "這張問題是問另一位發話者的。",
		cardInactive: `這張卡片已經失效（逾時，或 ${ctx.assistant} 重新啟動過）；需要的話直接打字回覆。`,
		cardApproved: "✅ 已核准執行。",
		cardDeclined: "❌ 已取消。",
		cardAnswerLabel: "回答…",
		cardOtherLabel: "其他…",
		cardOtherDescription: "自己寫答案",
		cardPickManyPlaceholder: "可以選好幾個",
		cardPickOnePlaceholder: "選一個",
		cardModalTitle: "回答",
		cardModalField: "你的回答",
		cardQuote: (text: string) => `「${text}」`,
		cardAnswered: (parts: readonly string[]) =>
			`已回答：${parts.join("、").slice(0, 300)}`,
	};
}
