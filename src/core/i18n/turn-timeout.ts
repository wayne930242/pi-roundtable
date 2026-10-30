import type { TurnTimeout } from "../domain/turn-timeout.ts";

/** A duration in whole seconds, as "3 min 12 s", "45 s", or "1 h 5 min". */
function durationEn(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const sec = s % 60;
	if (h > 0) return m > 0 ? `${h} h ${m} min` : `${h} h`;
	if (m > 0) return sec > 0 ? `${m} min ${sec} s` : `${m} min`;
	return `${sec} s`;
}

function durationZh(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const sec = s % 60;
	if (h > 0) return m > 0 ? `${h} 小時 ${m} 分` : `${h} 小時`;
	if (m > 0) return sec > 0 ? `${m} 分 ${sec} 秒` : `${m} 分`;
	return `${sec} 秒`;
}

/** The tools called so far, as the interim tool line shows them. */
function toolList(tools: TurnTimeout["tools"], separator: string): string {
	return tools
		.map(([name, count]) => (count > 1 ? `${name} ×${count}` : name))
		.join(separator);
}

/** The timeout card and the notice a turn posts when it ends at a time limit. */
export function turnTimeoutEn() {
	const doing = (t: TurnTimeout) =>
		t.running.length > 0
			? t.running
					.map(({ tool, ms }) => `${tool}, running for ${durationEn(ms)}`)
					.join("; ")
			: t.compacting
				? "compacting the conversation"
				: "waiting on the model";
	const limit = (t: TurnTimeout) =>
		t.limit === "turn"
			? `its time limit of ${durationEn(t.limitMs)} (since it started or since the last message steered into it)`
			: `its cap of ${durationEn(t.limitMs)} of work in all`;
	const tools = (t: TurnTimeout) =>
		t.tools.length > 0 ? `Tools so far: ${toolList(t.tools, " · ")}.` : "";
	return {
		turnTimeoutTitle: "⏱️ This turn is taking long",
		turnTimeoutQuestion: (t: TurnTimeout, budgetMs: number) =>
			[
				`It reached ${limit(t)} and has worked ${durationEn(t.workedMs)}.`,
				`Now: ${doing(t)}.`,
				tools(t),
				`It keeps working while this card is open. Continue gives it another ${durationEn(budgetMs)}; Cancel stops it. With no answer in ${durationEn(t.graceMs)} it stops.`,
			]
				.filter(Boolean)
				.join("\n"),
		turnTimeoutContinue: "Continue",
		turnTimeoutCancel: "Cancel",
		turnTimeoutFooter:
			"The turn is still working; answer whenever you are ready.",
		turnTimeoutContinued: "▶️ Continued.",
		turnTimeoutCancelled: "❌ Cancelled; the turn stops.",
		turnTimeoutFinished: "✅ The turn finished; nothing to answer.",
		turnTimeoutUnanswered: (t: TurnTimeout) =>
			`⏱️ No answer in ${durationEn(t.graceMs)}; the turn was stopped.`,
		turnTimedOutNotice: (t: TurnTimeout) => {
			const what =
				t.running.length > 0
					? `while ${t.running.map(({ tool, ms }) => `${tool} was running (${durationEn(ms)})`).join(" and ")}`
					: `while ${doing(t)}`;
			const head =
				t.end === "cancelled"
					? `⏱️ Cancelled by the owner after ${durationEn(t.workedMs)} ${what}.`
					: t.end === "unanswered"
						? `⏱️ No answer to the timeout card in ${durationEn(t.graceMs)}, so the turn was stopped after ${durationEn(t.workedMs)} ${what}.`
						: `⏱️ The turn reached ${limit(t)} and was stopped after ${durationEn(t.workedMs)} ${what}.`;
			const unasked = t.unasked
				? "No one was in the conversation to ask for more time. To let turns like this run longer, turn on long-running for this conversation, or give the schedule a longer time limit."
				: "";
			return [head, tools(t), unasked].filter(Boolean).join(" ");
		},
	};
}

export function turnTimeoutZhTW(): ReturnType<typeof turnTimeoutEn> {
	const doing = (t: TurnTimeout) =>
		t.running.length > 0
			? t.running
					.map(({ tool, ms }) => `${tool}，已執行 ${durationZh(ms)}`)
					.join("；")
			: t.compacting
				? "正在壓縮對話"
				: "正在等模型回應";
	const limit = (t: TurnTimeout) =>
		t.limit === "turn"
			? `時間上限 ${durationZh(t.limitMs)}（從開始或最後一則插入的訊息算起）`
			: `總工作時間上限 ${durationZh(t.limitMs)}`;
	const tools = (t: TurnTimeout) =>
		t.tools.length > 0 ? `目前用過的工具：${toolList(t.tools, " · ")}。` : "";
	return {
		turnTimeoutTitle: "⏱️ 這一輪做得比較久",
		turnTimeoutQuestion: (t: TurnTimeout, budgetMs: number) =>
			[
				`已達到${limit(t)}，已工作 ${durationZh(t.workedMs)}。`,
				`現在：${doing(t)}。`,
				tools(t),
				`這張卡片開著時它會繼續工作。按「繼續」再給它 ${durationZh(budgetMs)}；按「取消」停止。${durationZh(t.graceMs)}內沒有回答就會停止。`,
			]
				.filter(Boolean)
				.join("\n"),
		turnTimeoutContinue: "繼續",
		turnTimeoutCancel: "取消",
		turnTimeoutFooter: "這一輪仍在工作；準備好再回答即可。",
		turnTimeoutContinued: "▶️ 已繼續。",
		turnTimeoutCancelled: "❌ 已取消，這一輪會停止。",
		turnTimeoutFinished: "✅ 這一輪已完成，不需要回答。",
		turnTimeoutUnanswered: (t: TurnTimeout) =>
			`⏱️ ${durationZh(t.graceMs)}內沒有回答，這一輪已停止。`,
		turnTimedOutNotice: (t: TurnTimeout) => {
			const what =
				t.running.length > 0
					? `當時 ${t.running.map(({ tool, ms }) => `${tool} 正在執行（${durationZh(ms)}）`).join("、")}`
					: `當時${doing(t)}`;
			const head =
				t.end === "cancelled"
					? `⏱️ 擁有者在工作 ${durationZh(t.workedMs)} 後取消了這一輪，${what}。`
					: t.end === "unanswered"
						? `⏱️ 逾時卡片在 ${durationZh(t.graceMs)}內沒有回答，這一輪在工作 ${durationZh(t.workedMs)} 後停止，${what}。`
						: `⏱️ 這一輪達到${limit(t)}，在工作 ${durationZh(t.workedMs)} 後停止，${what}。`;
			const unasked = t.unasked
				? "當時對話裡沒有人可以問要不要再給時間。要讓這類回合跑久一點，可以替這個對話開啟長時間執行，或替排程設定較長的時間上限。"
				: "";
			return [head, tools(t), unasked].filter(Boolean).join(" ");
		},
	};
}
