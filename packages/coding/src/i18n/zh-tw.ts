/** The coding plugin's Traditional Chinese (Taiwan) wording, keyed by the English text; a host's `presentation.messages` wins, key by key. */
export const ZH_TW: Readonly<Record<string, string>> = {
	"Coding workers": "程式工作者",
	"At most {max} at once. Running now: {running}. Waiting in the queue: {queued}.":
		"同時最多 {max} 個。執行中：{running}。排隊等候：{queued}。",
	"Worker limit": "工作者上限",
	Save: "儲存",
	"Coding workers at once": "同時執行的程式工作者",
	"Shared by every agent and repository, 1 to {most}. Extra tasks wait in a queue. Lowering it lets running workers finish.":
		"所有代理與儲存庫共用，可設 1 到 {most}。超出的任務會排隊等候。調低時，執行中的工作者會先做完。",
	"Only an owner changes this.": "只有擁有者能變更這項設定。",
	"This page has no such action.": "這個頁面沒有這個動作。",
	"Give a whole number from 1 to {most}.": "請輸入 1 到 {most} 的整數。",
	"Up to {max} coding workers now run at once.":
		"現在同時最多執行 {max} 個程式工作者。",
	Tasks: "任務",
	Cancel: "取消",
	"Running since {at}, started by {who}": "自 {at} 執行中，由 {who} 啟動",
	"Queued (position {position}) since {at}, started by {who}":
		"自 {at} 排隊中（第 {position} 位），由 {who} 啟動",
	"Stop coding task #{id}? Its commits stay on its branch, not merged.":
		"要停止程式任務 #{id} 嗎？它的提交會留在自己的分支上，不會合併。",
	"Drop coding task #{id} from the queue?": "要把程式任務 #{id} 移出佇列嗎？",
	"Coding task #{id} is no longer running or queued.":
		"程式任務 #{id} 已不在執行或排隊中。",
	"Coding task #{id} was dropped from the queue.":
		"程式任務 #{id} 已移出佇列。",
	"Coding task #{id} was stopped; its commits stay on {branch}, not merged.":
		"程式任務 #{id} 已停止；它的提交留在 {branch}，沒有合併。",
	"Coding task #{id} was stopped.": "程式任務 #{id} 已停止。",
};
