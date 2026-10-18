import type { CatalogContext } from "./types.ts";

/** `text` cut to at most 300 UTF-16 units without splitting a surrogate pair. */
function clip(text: string, max: number): string {
	if (text.length <= max) return text;
	const last = text.charCodeAt(max - 1);
	return text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}

/** The owner's approval and question cards. */
export function cardsEn(ctx: CatalogContext) {
	return {
		cardRunLabel: "Run",
		cardCancelLabel: "Cancel",
		cardCopyLabel: "Copy",
		cardCopyGone:
			"The text of this card is no longer kept; ask the assistant to show it again.",
		cardCopyFile: "The text is long, so it is attached as a file.",
		cardApprovalFooter:
			"Nothing runs until you approve; answer whenever you are ready.",
		cardQuestionFooter: "Answer whenever you are ready.",
		cardStopped: "⏹️ This round was stopped.",
		cardWithdrawn: "↩️ Withdrawn; nothing will run.",
		cardOwnerOnly: `Only ${ctx.assistant}'s owner can answer this card.`,
		cardApproversNote: (...userIds: readonly string[]) =>
			`-# Who can approve: ${userIds.map((id) => `<@${id}>`).join(" ")}`,
		cardApproversRefusal:
			"This approval is for the speaker whose turn asked for it.",
		cardNamedApproversRefusal:
			"This approval is for the people it names, and the owners.",
		cardAskerNote: (...userIds: readonly string[]) =>
			`-# Who can answer: ${userIds.map((id) => `<@${id}>`).join(" ")}`,
		cardAskerRefusal: "This question is for another speaker.",
		cardInactive: `This card is no longer valid (${ctx.assistant} restarted since it was posted, or it was already answered or withdrawn); ask again, or reply in text.`,
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
			`Answered: ${clip(parts.join(", "), 300)}`,
		cardPreviewsFile:
			"The previews contain code blocks, so they are attached as a file.",
		cardSubmitLabel: "Submit",
		cardWriteLabel: "Write answers / note…",
		cardPreviewsLabel: "Previews",
		cardQuestionName: (n: number) => `Question ${n}`,
		cardNoteField: "Note on all answers",
		cardNothingYet: "Choose or write at least one answer first.",
		cardQuestionnaireFooter: (answered: number, total: number) =>
			`${answered} of ${total} answered; submit when you are ready.`,
		cardUnanswered: "not answered",
		cardNoteLine: (note: string) => `Note: ${note}`,
	};
}

export function cardsZhTW(ctx: CatalogContext): ReturnType<typeof cardsEn> {
	return {
		cardRunLabel: "執行",
		cardCancelLabel: "取消",
		cardCopyLabel: "複製",
		cardCopyGone: "這張卡片的文字已經不在了；請再請助理顯示一次。",
		cardCopyFile: "文字比較長，所以用檔案附上。",
		cardApprovalFooter: "你核准之前不會執行；準備好再回覆就好。",
		cardQuestionFooter: "準備好再回答就好。",
		cardStopped: "⏹️ 這一輪已停止。",
		cardWithdrawn: "↩️ 已撤回，不會執行。",
		cardOwnerOnly: `只有 ${ctx.assistant} 的擁有者能回答這張卡片。`,
		cardApproversNote: (...userIds: readonly string[]) =>
			`-# 可以核准的人：${userIds.map((id) => `<@${id}>`).join(" ")}`,
		cardApproversRefusal: "這張核准卡是給提出這一輪的發話者的。",
		cardNamedApproversRefusal: "這張核准卡是給卡片上點名的人和擁有者的。",
		cardAskerNote: (...userIds: readonly string[]) =>
			`-# 可以回答的人：${userIds.map((id) => `<@${id}>`).join(" ")}`,
		cardAskerRefusal: "這張問題是問另一位發話者的。",
		cardInactive: `這張卡片已經失效（${ctx.assistant} 在它發出後重新啟動過，或它已經回答過或被撤回）；請再問一次，或直接打字回覆。`,
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
			`已回答：${clip(parts.join("、"), 300)}`,
		cardPreviewsFile: "預覽裡有程式碼區塊，所以用檔案附上。",
		cardSubmitLabel: "送出",
		cardWriteLabel: "寫答案／備註…",
		cardPreviewsLabel: "預覽",
		cardQuestionName: (n: number) => `問題 ${n}`,
		cardNoteField: "給全部答案的備註",
		cardNothingYet: "請先選或寫至少一個答案。",
		cardQuestionnaireFooter: (answered: number, total: number) =>
			`已回答 ${answered}／${total} 題；準備好再送出。`,
		cardUnanswered: "未回答",
		cardNoteLine: (note: string) => `備註：${note}`,
	};
}
