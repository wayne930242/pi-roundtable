import type { CatalogContext } from "./types.ts";

/** The agent panel of `/<root> profile`: its text, buttons, and forms. */
export function agentPanelEn(ctx: CatalogContext) {
	return {
		agentSkillBuiltin: (name: string) => `\`${name}\` (built in)`,
		agentSkills: (names: readonly string[]) =>
			`**Skills** · ${names.join(", ")}`,
		agentSkillMissing: (name: string, reason: string) =>
			`⚠️ \`${name}\` could not be loaded: ${reason}`,
		agentGroupChannel: `This is a group channel with no agent of its own. See its members and host with \`/${ctx.root} status\`; to change a member, use \`/${ctx.root} profile\` in its channel.`,
		agentNoAgent: `This channel has no agent. \`/${ctx.root} profile\` works in an agent's channel in the agent server.`,
		agentFollowsAssistant: `(follows ${ctx.assistant})`,
		agentHeader: (v: {
			displayName: string;
			name: string;
			model: string;
			thinking: string;
			follows: string;
			skills: string;
		}) =>
			`### ${v.displayName}\n-# agent name \`${v.name}\`, cannot be changed\n**Model** · \`${v.model}\` · thinking \`${v.thinking}\`${v.follows}\n${v.skills}\n-# To add or remove a skill, ask any agent to use agent_skills.`,
		agentAvatarPromptText: (prompt: string) => `**Avatar prompt**\n${prompt}`,
		agentPromptInline: (prompt: string) =>
			`**Prompt**\n\`\`\`\n${prompt}\n\`\`\``,
		agentPromptFile: (length: number) =>
			`**Prompt** · ${length} characters, the full text is in the file below.`,
		agentEditPromptLabel: "Edit prompt",
		agentRedrawLabel: "Redraw avatar",
		agentNewAvatarPromptLabel: "New avatar prompt",
		agentEditAvatarLabel: "Edit avatar",
		agentModelLabel: "Model",
		agentDefaultNote:
			"A changed prompt takes effect from this agent's next turn; the conversation history is kept.",
		agentNotFound: "That agent was not found.",
		agentFollowAssistant: (value: string) =>
			`Follow ${ctx.assistant} (${value})`,
		agentModelModalTitle: (displayName: string) => `${displayName}'s model`,
		agentEditModalTitle: (displayName: string) => `Edit ${displayName}`,
		agentDisplayNameLabel: "Display name",
		agentPromptLabel: "Prompt",
		agentAvatarPromptLabel: "Avatar prompt (state the background colour)",
		agentEditAvatarField: "How to change it (for example: add a hat)",
		agentSaved: "Saved; it takes effect from the next turn.",
		agentAvatarRedrawn: "The new avatar shows from this agent's next message.",
		agentAvatarFailed: (message: string) =>
			`The avatar was not drawn: ${message}`,
	};
}

export function agentPanelZhTW(
	ctx: CatalogContext,
): ReturnType<typeof agentPanelEn> {
	return {
		agentSkillBuiltin: (name: string) => `\`${name}\`（內建）`,
		agentSkills: (names: readonly string[]) => `**Skill**　${names.join("、")}`,
		agentSkillMissing: (name: string, reason: string) =>
			`⚠️ \`${name}\` 無法載入：${reason}`,
		agentGroupChannel: `這是群組頻道，沒有自己的 agent。成員和主持人請用 \`/${ctx.root} status\` 查看；要改某個成員，到它的頻道用 \`/${ctx.root} profile\`。`,
		agentNoAgent: `這個頻道沒有 agent。\`/${ctx.root} profile\` 要在 agent 伺服器裡某個 agent 的頻道使用。`,
		agentFollowsAssistant: `（跟隨 ${ctx.assistant}）`,
		agentHeader: (v: {
			displayName: string;
			name: string;
			model: string;
			thinking: string;
			follows: string;
			skills: string;
		}) =>
			`### ${v.displayName}\n-# agent 名稱 \`${v.name}\`，不能更改\n**模型**　\`${v.model}\`　thinking \`${v.thinking}\`${v.follows}\n${v.skills}\n-# 要增減 skill，請任一個 agent 用 agent_skills。`,
		agentAvatarPromptText: (prompt: string) => `**頭像提示詞**\n${prompt}`,
		agentPromptInline: (prompt: string) =>
			`**提示詞**\n\`\`\`\n${prompt}\n\`\`\``,
		agentPromptFile: (length: number) =>
			`**提示詞**　${length} 字，完整內容在下面的檔案。`,
		agentEditPromptLabel: "編輯提示詞",
		agentRedrawLabel: "重畫頭像",
		agentNewAvatarPromptLabel: "新頭像提示詞",
		agentEditAvatarLabel: "修改頭像",
		agentModelLabel: "模型",
		agentDefaultNote:
			"提示詞改完，從這個 agent 的下一回合開始生效；對話紀錄保留。",
		agentNotFound: "找不到這個 agent。",
		agentFollowAssistant: (value: string) =>
			`跟隨 ${ctx.assistant}（${value}）`,
		agentModelModalTitle: (displayName: string) => `${displayName} 的模型`,
		agentEditModalTitle: (displayName: string) => `編輯 ${displayName}`,
		agentDisplayNameLabel: "顯示名",
		agentPromptLabel: "提示詞",
		agentAvatarPromptLabel: "頭像提示詞（寫明背景色）",
		agentEditAvatarField: "要怎麼改（例如：加一頂帽子）",
		agentSaved: "已儲存，從下一回合開始生效。",
		agentAvatarRedrawn: "新頭像從這個 agent 的下一則訊息開始顯示。",
		agentAvatarFailed: (message: string) => `頭像沒有畫成：${message}`,
	};
}
