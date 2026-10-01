# pi-roundtable

[English](README.md) | 繁體中文

一個建立在 [Pi](https://github.com/earendil-works/pi) 上的 Discord 智慧體（agent）伺服器。
你會在一個 Discord 伺服器裡得到一組 AI 智慧體：每個智慧體擁有一個頻道和一段對話，彼此共用工具與記憶，你用 TypeScript 寫外掛（plugin）來擴充這個 bot。

- 為一位擁有者和一個 Discord 伺服器設計。你可以允許其他人與智慧體對話，但這樣的設定與風險由營運者自行承擔。
- 只支援 Bun。套件直接發佈 TypeScript 原始碼，不需要建置步驟。
- MIT 授權。

## 你需要準備

- [Bun](https://bun.sh/docs/installation) 1.3 以上。
- PostgreSQL。`init` 建立的專案附有 `docker-compose.yml`，可以直接啟動一個。
- 一個 Discord bot：一個含 bot 使用者、已開啟 Message Content intent，並已邀請進你的伺服器的應用程式。
- 模型登入：你選的模型的供應商 API key（`anthropic/...` 用 `ANTHROPIC_API_KEY`），或用 Pi 做過的登入。
- 一個能從網際網路連到這個行程的位址，例如通道（tunnel），因為 Discord 會從該位址取得智慧體的頭像。

## 五分鐘上手

```sh
npx pi-roundtable init my-bot    # 或：bunx pi-roundtable init my-bot
cd my-bot
bun install
docker compose up -d             # PostgreSQL，與 .env.example 一致
cp .env.example .env             # 然後填入內容
bunx roundtable doctor
bunx roundtable start
```

`init` 會寫出一個可運作的專案，不會向你要任何祕密資訊。
Bun 不存在或版本太舊，或它要建立的檔案已經存在時，它不會寫入任何東西。

### `.env`

`.env.example` 說明了每個值的來源。
Bun 會自行載入 `.env`，`.gitignore` 也已讓它不進 Git。

| 變數 | 內容 |
| --- | --- |
| `DISCORD_TOKEN` | bot 的 token，在應用程式的 Bot 頁面取得 |
| `DISCORD_GUILD_ID`、`DISCORD_ENTRY_CHANNEL_ID` | 伺服器，以及負責統籌的智慧體所在的頻道（開啟開發者模式後，按右鍵複製 id） |
| `OWNER_ID`、`OWNER_NAME` | 你自己：唯一能改動一切的人 |
| `DATABASE_URL` | PostgreSQL；預設值與 `docker-compose.yml` 一致 |
| `MODEL` | 智慧體使用的模型，格式為 `<provider>/<id>` |
| `PUBLIC_URL` | 能從網際網路連到這個行程的位址 |

### `doctor`

`bunx roundtable doctor` 依序檢查下列項目，逐項印出通過或失敗，並說明如何修正：

1. Bun 的版本。
2. `.env` 對 `.env.example` 列出的每個變數都有值。
3. `roundtable.config.ts` 符合其 schema，失敗時指出是哪個鍵。
4. 每個外掛都能載入，且沒有兩個外掛同名。
5. 是否有外掛填入 `images` 槽位。沒有並不算失敗：智慧體會用顯示名稱產生頭像。
6. PostgreSQL 連得上，且能執行 migration。
7. Discord token 有效、bot 已在你的伺服器裡、Message Content intent 已開啟，而且 bot 在入口頻道有它需要的權限（包含 Pin Messages）。
   bot 不在伺服器裡時，修正方式是一個邀請連結，連結要求的正是這些權限。
8. 模型登入存在。
9. `PUBLIC_URL` 是格式正確的位址；加上 `--reachable` 時它還必須有回應，這只有在 bot 執行中才成立。

任何一項失敗，它就以非零狀態結束，並且不更動它檢查過的任何東西。
全新的專案只會因為你還沒填的憑證而失敗，而且會指出是哪些。

### `start`

`bunx roundtable start` 先執行不需要網路的檢查，其中任何一項失敗就停下來，並印出與 `doctor` 相同的訊息；全部通過則啟動 bot。
啟動後，`agents.ts` 裡的智慧體都有了自己的頻道，`/roundtable help` 會開啟控制面板。
收到 `SIGTERM` 或 `SIGINT` 時，它會先讓進行中的工作完成再停止。

## 外掛

`roundtable add plugin <name>` 會建立 `plugins/<name>.ts` 和它的測試，並把它列進 `roundtable.config.ts`。
外掛是一個有名稱和 `setup` 函式的物件，`setup` 回傳它要新增的東西；下面這個外掛給每個智慧體一個工具：

```ts
import { definePlugin, defineTool } from "pi-roundtable";
import { Type } from "typebox";

export const hello = definePlugin({
	name: "hello",
	setup: () => ({
		tools: [
			defineTool({
				name: "hello_greet",
				description: "Greet someone by name. Call it when asked to say hello.",
				parameters: Type.Object({ who: Type.String() }),
				minTier: "member",
				run: ({ who }) => `Hello, ${who}!`,
			}),
		],
	}),
});
```

測試時不需要 Discord 或 PostgreSQL：

```ts
import { expect, test } from "bun:test";
import { testPlugin } from "pi-roundtable/testing";
import { hello } from "./hello.ts";

test("hello greets", async () => {
	const harness = await testPlugin(hello);
	expect(await harness.runTool("hello_greet", { who: "Ada" })).toBe("Hello, Ada!");
	await harness.stop();
});
```

[外掛指南](docs/plugins.md)（英文）說明外掛能新增的每個部分（工具、提示詞區段、智慧體、事件、服務、migration、provider、斜線指令、HTTP 路由等等）、啟動與停止的順序，以及每一種啟動錯誤和它的修正方式。
指南裡的範例放在 [`examples/`](examples)，測試套件會執行每一個範例。
`pi-roundtable/kit` 提供頻道認領（claim）、工具與呈現用的輔助函式，以及 context 現有服務的純型別名稱；`pi-roundtable/discord` 提供斜線指令註冊器、擁有者指令與面板的輔助函式，以及智慧體面板，是會用到 discord.js 型別的入口（`pi-roundtable/testing` 也透過 `testHost` 組合出的指令用到少數幾個）。這兩個入口在 1.0 之前都不穩定，不受語意化版本（semver）保證。

## 設定

`roundtable.config.ts` 放設定和外掛清單。
未知的鍵會報錯，並指出最接近的已知鍵。

bot 在 Discord 裡顯示的文字語言由 `locale` 設定決定：預設是 `en`，也可以是 `zh-TW`。

```ts
export default {
	// ...
	locale: "zh-TW",
	timeZone: "Europe/Berlin", // 排程與時間戳記使用的時區；預設為 UTC
	plugins: [hello],
} satisfies RoundtableConfig;
```

## 指令

| 指令 | 作用 |
| --- | --- |
| `roundtable init [dir]` | 在 `dir`（預設為目前目錄）建立專案 |
| `roundtable doctor [--reachable]` | 檢查設定，並說明如何修正有問題的地方 |
| `roundtable start` | 先執行不需要網路的檢查，再啟動 bot |
| `roundtable add plugin <name>` | 新增 `plugins/<name>.ts` 和它的測試，並列進設定 |

## 變更與授權

[CHANGELOG.md](CHANGELOG.md)（英文）列出套件匯出名稱的每一項變更。
[MIT](LICENSE)。
