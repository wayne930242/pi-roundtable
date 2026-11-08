/** The zh-TW wording of the agent rooms' incoming webhooks, merged into the built-in catalog. */
export const ZH_TW_WEBHOOKS: Readonly<Record<string, string>> = {
	// 伺服器的拒絕訊息
	"A webhook needs a name of 1 to 80 characters.":
		"Webhook 需要 1 到 80 個字元的名稱。",
	"A webhook expires after 1 minute to 7 days, in whole minutes.":
		"Webhook 的期限須為 1 分鐘到 7 天之間的整數分鐘。",
	"once must be true or false.": "once 必須是 true 或 false。",
	"This knight already has 20 expiring webhooks. Revoke one first.":
		"這位騎士已有 20 個會到期的 Webhook，請先撤銷一個。",
	"This knight already has 10 webhooks that never expire. Revoke one first.":
		"這位騎士已有 10 個永不到期的 Webhook，請先撤銷一個。",
	"There is no such knight.": "沒有這位騎士。",
	"Only an active permanent knight has webhooks.":
		"只有啟用中的正式騎士才有 Webhook。",
	"There is no such webhook.": "沒有這個 Webhook。",
	"The request body is not valid.": "請求內容無效。",
	// 騎士設定的「更多」分頁
	Webhooks: "Webhook",
	Webhook: "Webhook",
	"A JSON POST to a webhook's URL shows in this room and starts a report turn, as a Discord webhook does. What it posts is untrusted input.":
		"以 JSON POST 到 Webhook 的網址，內容會顯示在這個聊天室並啟動一次回報，就像 Discord 的 Webhook。它送來的內容一律視為不可信的輸入。",
	"No webhooks yet.": "還沒有 Webhook。",
	"One post": "限用一次",
	"Made by an owner": "由擁有者建立",
	"Made by the knight": "由騎士自己建立",
	"Created {at}": "建立於 {at}",
	"Last used {at}": "上次使用 {at}",
	"Never used": "尚未使用",
	"Expires {at}": "{at} 到期",
	"Never expires": "永不到期",
	"Webhook name": "Webhook 名稱",
	Expires: "到期",
	Never: "永不",
	"1 hour": "1 小時",
	"1 day": "1 天",
	"7 days": "7 天",
	"Make a webhook": "建立 Webhook",
	"Webhook URL of {name}": "{name} 的 Webhook 網址",
	"This URL is shown only this once, and anyone who has it can post into this room. Keep it in a secret store, such as a GitHub secret, never in a repository or a message.":
		"這個網址只會顯示這一次，任何拿到它的人都能在這個聊天室發文。請存放在機密儲存處（例如 GitHub secret），切勿放進程式庫或訊息中。",
	"Webhook URL": "Webhook 網址",
	"Revoke the webhook": "撤銷 Webhook",
	"Revoke {name}? Its URL stops working at once.":
		"要撤銷{name}嗎？它的網址會立即失效。",
};
