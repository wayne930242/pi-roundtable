import type { CatalogContext } from "./types.ts";

/** The owner's approval and question cards. */
export function cardsEn(ctx: CatalogContext) {
	return {
		cardRunLabel: "Run",
		cardCancelLabel: "Cancel",
		cardApprovalFooter:
			"Nothing runs until you approve; answer whenever you are ready.",
		cardQuestionFooter: "Answer whenever you are ready.",
		cardStopped: "⏹️ This round was stopped.",
		cardOwnerOnly: `Only ${ctx.assistant}'s owner can answer this card.`,
		cardApproversNote: (...userIds: readonly string[]) =>
			`-# Who can approve: ${userIds.map((id) => `<@${id}>`).join(" ")}`,
		cardApproversRefusal:
			"This approval is for the speaker whose turn asked for it.",
		cardAskerNote: (...userIds: readonly string[]) =>
			`-# Who can answer: ${userIds.map((id) => `<@${id}>`).join(" ")}`,
		cardAskerRefusal: "This question is for another speaker.",
		cardInactive: `This card is no longer valid (${ctx.assistant} restarted since it was posted, or it was already answered); ask again, or reply in text.`,
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
		cardApprovalFooter: "你核准之前不會執行；準備好再回覆就好。",
		cardQuestionFooter: "準備好再回答就好。",
		cardStopped: "⏹️ 這一輪已停止。",
		cardOwnerOnly: `只有 ${ctx.assistant} 的擁有者能回答這張卡片。`,
		cardApproversNote: (...userIds: readonly string[]) =>
			`-# 可以核准的人：${userIds.map((id) => `<@${id}>`).join(" ")}`,
		cardApproversRefusal: "這張核准卡是給提出這一輪的發話者的。",
		cardAskerNote: (...userIds: readonly string[]) =>
			`-# 可以回答的人：${userIds.map((id) => `<@${id}>`).join(" ")}`,
		cardAskerRefusal: "這張問題是問另一位發話者的。",
		cardInactive: `這張卡片已經失效（${ctx.assistant} 在它發出後重新啟動過，或它已經回答過了）；請再問一次，或直接打字回覆。`,
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
