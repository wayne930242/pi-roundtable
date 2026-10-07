# pi-roundtable

[English](./README.md) | 繁體中文

文件：<https://pi-roundtable.wayneh.tw>
原始碼與 issue：<https://github.com/wayne930242/pi-roundtable>

一個建立在 [Pi](https://github.com/earendil-works/pi) 上的智慧體（agent）伺服器，可以透過 Discord 或網頁聊天跟它對話。
在 Discord 裡，每個 AI 智慧體在你的伺服器有自己的頻道和對話，共用工具與記憶。
在網頁上，經你的 OpenID Connect 供應商登入的人，透過 [pi-roundtable-webchat](packages/webchat) 在各自的私人對話裡跟助理聊天。
想加功能，就用 TypeScript 寫外掛（plugin）。

- 為一位擁有者設計。Discord 和網頁聊天都能用，也可以讓其他人跟助理對話，但開放給多人使用的風險由營運者自行承擔：請先讀[威脅模型](#威脅模型)。
- 只支援 Bun。套件直接發佈 TypeScript 原始碼，不需要建置步驟。
- MIT 授權。

## 你需要準備

- [Bun](https://bun.sh/docs/installation) 1.3 以上。
- PostgreSQL。`init` 建立的專案附有 `docker-compose.yml`，可以直接啟動一個。
- 模型登入：你選的模型的供應商 API key（`anthropic/...` 用 `ANTHROPIC_API_KEY`），或之前用 Pi 登入過的帳號。
- 用 Discord 的話：一個 Discord bot（有 bot 使用者、開了 Message Content intent，也已經邀請進你的伺服器），以及一個從網際網路連得到這個行程的位址，例如通道（tunnel）。Discord 要從這個位址抓智慧體的頭像。
- 用網頁聊天的話：一個會為聊天 API 簽發 access token 的 OpenID Connect 供應商，以及一個用 HTTPS 對外提供服務的反向代理。

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

`init` 會寫出一個能跑的專案，過程不會問你任何祕密資訊。
Bun 沒裝、版本太舊，或要建立的檔案已經存在時，它什麼都不寫。
`init --adapter web` 則寫出一個沒有 Discord、以網頁聊天為中心的專案，見[網頁聊天](#網頁聊天)。
兩種專案都會載入 Pi package pi-self-compact，每個 session 都需要它提供的 `compact_session` 工具。

### `.env`

`.env.example` 說明了每個值的來源。
Bun 會自己讀 `.env`，`.gitignore` 也已經擋掉它。

| 變數 | 內容 |
| --- | --- |
| `DISCORD_TOKEN` | bot 的 token，在應用程式的 Bot 頁面取得 |
| `DISCORD_GUILD_ID`、`DISCORD_ENTRY_CHANNEL_ID` | 伺服器，以及負責統籌的智慧體所在的頻道（開啟開發者模式後，按右鍵複製 id） |
| `OWNER_ID`、`OWNER_NAME` | 你自己：唯一能改動一切的人 |
| `DATABASE_URL` | PostgreSQL；預設值與 `docker-compose.yml` 一致 |
| `MODEL` | 智慧體使用的模型，格式為 `<provider>/<id>` |
| `PUBLIC_URL` | 能從網際網路連到這個行程的位址 |

網頁聊天專案要填的是 `OWNER_NAME`、`DATABASE_URL`、`MODEL`，以及 OpenID Connect 的 issuer、audience、簽章金鑰位址、可以聊天的角色，和會開啟聊天的網頁來源（origin）。

### `doctor`

`bunx roundtable doctor` 依序檢查下列項目，逐項印出通過或失敗，並說明如何修正：

1. Bun 的版本。
2. `.env` 對 `.env.example` 列出的每個變數都有值。
3. `roundtable.config.ts` 符合其 schema，失敗時指出是哪個鍵。
4. 每個外掛都能載入，且沒有兩個外掛同名。
5. 有沒有外掛填了 `images` 槽位。沒有也不算失敗，智慧體會用顯示名稱產生頭像。
6. PostgreSQL 連得上，且能執行 migration。
7. 有設定 Discord 時：Discord token 有效、bot 已在你的伺服器裡、Message Content intent 已開啟，而且 bot 在入口頻道有它需要的權限（包含 Pin Messages）。
   bot 還不在伺服器裡的話，它會給你一個邀請連結，連結已經帶好這些權限。
8. 模型登入存在。
9. 有設定 Discord 時：`PUBLIC_URL` 的格式正確；加上 `--reachable` 還要求它有回應，所以 bot 得先跑起來。

只要有一項失敗，就以非零狀態結束，檢查過程不會改動任何東西。
全新的專案只會卡在還沒填的憑證，它會列出是哪幾個。

### `start`

`bunx roundtable start` 先執行不需要網路的檢查，其中任何一項失敗就停下來，並印出與 `doctor` 相同的訊息；全部通過則啟動 bot。
啟動後，`agents.ts` 裡的智慧體都有了自己的頻道，`/roundtable schedule list` 可以列出它們的排程。
收到 `SIGTERM` 或 `SIGINT` 時，它會先讓進行中的工作完成再停止。

## 外掛

`roundtable add plugin <name>` 會建立 `plugins/<name>.ts` 和它的測試，並把它列進 `roundtable.config.ts`。
`roundtable add package <spec>` 對 npm 上的 Pi package 做同樣的事：安裝套件，並寫好一個載入它的擴充、選用它的工具的外掛。
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
`pi-roundtable/kit` 提供頻道認領（claim）、工具與呈現用的輔助函式，以及 context 現有服務的純型別名稱。
`pi-roundtable/discord` 提供斜線指令註冊器、擁有者指令與面板的輔助函式，以及智慧體面板；它是會用到 discord.js 型別的入口（`pi-roundtable/testing` 也透過 `testHost` 組合出的指令用到少數幾個）。
這兩個入口的版本規則與主入口相同：1.0 之前，不相容的變更會放在次版本（minor）發佈，並列在變更記錄中。

## 網頁聊天

套件 [pi-roundtable-webchat](packages/webchat) 是以外掛形式提供的聊天管道：在主機的 listener 上的 `/chat` 底下提供 WebSocket 和 REST API。
經你的 OpenID Connect 供應商登入的人，可以用你列出的人格（persona）開私人對話，在每一輪執行時看到它寫的文字和用的工具，也能回答暫緩呼叫的核准卡。
設定裡沒有 `discord`、`plugins` 列了 `webChat({ ... })` 的主機，就是只有網頁的助理；`roundtable init --adapter web` 會建立這種專案。

```sh
npx pi-roundtable init my-desk --adapter web
```

它的 README（英文）說明協定、存取對照、各項上限，以及讓同一個人只有一個身分的[供應商設定](packages/webchat/README.md#provider-settings)，例如使用穩定的 subject claim、固定租戶。

## MCP connector

獨立套件 [pi-roundtable-mcp](https://www.npmjs.com/package/pi-roundtable-mcp) 用兩個外掛，把 bot 雙向接上 MCP：

- `mcpConnectors`：你在 Discord 用私人表單加入一台 MCP server，例如 Notion、行事曆，或任何用 HTTP 提供 MCP 的服務。
  接著由你的程式碼把它的工具交給你選的智慧體。
  每台 server 和它的 token 由你自己架的 [ContextForge](https://github.com/IBM/mcp-context-forge) gateway 保管。
- `remoteMcp`：Discord 以外的智慧體透過 MCP 傳訊息給你的智慧體，並讀取回答。
  它也能使用你授權的 Discord 頻道，而且只限你選的操作。

```sh
bun add pi-roundtable-mcp
```

它與 pi-roundtable 同步發版，每個選項都列在它的 README。

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

## 威脅模型

pi-roundtable 為一位擁有者執行一個助理。
它還沒有像多使用者服務那樣把對話的人彼此隔開；開放給別人使用的人要自己承擔這部分。

- **信任誰。** 營運者掌控主機、設定和憑證。擁有者（`owner.id`）可以使用每一個工具。其他人以某個 tier（`member` 或 `admin`）進來：Discord 依 `speakers` 裡的使用者與角色 id，網頁依存取對照表和 token 的角色。沒有任何 token claim 能讓人成為擁有者。
- **一輪能做什麼。** 一輪只拿得到發言者的 tier 允許的工具；沒有外掛給 tier 的工具只有擁有者能用。工具在主機的行程裡執行，用的是主機的檔案和網路：`web_search` 和 `fetch_content` 連得到內部位址，所以網頁人格要在 `selection` 裡寫明它的工具。外掛也在同一個行程裡執行，權限一樣。
- **核准。** 暫緩的呼叫只能由讓它暫緩的那一輪的發言者核准，而且發言者的 tier 仍要足以執行這個呼叫；擁有者也可以核准。核准卡和確認訊息都適用這條規則。
- **對話。** Discord 裡智慧體的頻道和群組房間是共用的：在那裡發言的每個人，都會寫進智慧體讀取的同一段對話。網頁聊天的對話屬於開啟它的人，只有開啟者本人能讀、能發言、能回答它的提問。
- **記憶。** 每位發言者的記憶各自分開。同一個人從 Discord 和網頁發言會有兩個身分、兩份記憶，要等 0.9 加入 principal 才會合併。
- **模型憑證。** 每一輪不論誰發言，都用主機的模型登入執行、由它計費。每個人自己的憑證預計在之後的版本加入。
- **資料。** 對話、記憶和排程以未加密的形式存在 PostgreSQL 和資料目錄裡。

## 升級

[升級到 0.8](docs/migrating-0.8.md)（英文）說明怎麼把 0.7 的 Discord 專案升級（不需要改設定），以及怎麼啟動沒有 Discord 的主機。

## 指令

| 指令 | 作用 |
| --- | --- |
| `roundtable init [dir] [--adapter discord\|web]` | 在 `dir`（預設為目前目錄）建立專案，透過 Discord（預設）或 pi-roundtable-webchat 對話 |
| `roundtable doctor [--reachable]` | 檢查設定，並說明如何修正有問題的地方 |
| `roundtable start` | 先執行不需要網路的檢查，再啟動 bot |
| `roundtable add plugin <name>` | 新增 `plugins/<name>.ts` 和它的測試，並列進設定 |
| `roundtable add package <spec>` | 用 `bun add` 安裝 Pi package，並新增一個載入它、把它的工具交給每一輪 agent 的外掛 |

## 變更與授權

[CHANGELOG.md](CHANGELOG.md)（英文）列出套件匯出名稱的每一項變更。
[MIT](LICENSE)。
