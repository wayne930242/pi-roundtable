# pi-roundtable

[English](./README.md) | 繁體中文

文件：<https://pi-roundtable.wayneh.tw>
原始碼與 issue：<https://github.com/wayne930242/pi-roundtable>

一個建立在 [Pi](https://github.com/earendil-works/pi) 上的智慧體（agent）伺服器，可以透過 Discord 或網頁聊天跟它對話。
在 Discord 裡，每個 AI 智慧體在你的伺服器有自己的頻道和對話，共用工具與記憶。
在網頁上，經你的 OpenID Connect 供應商登入的人，透過 [pi-roundtable-webchat](packages/webchat) 在各自的私人對話裡跟騎士聊天。
想加功能，就用 TypeScript 寫外掛（plugin）。

- 為一位擁有者設計。Discord 和網頁聊天都能用，也可以讓其他人跟騎士對話，但開放給多人使用的風險由營運者自行承擔：請先讀[威脅模型](#威脅模型)。
- 只支援 Bun。套件直接發佈 TypeScript 原始碼，不需要建置步驟。
- MIT 授權。

## 你需要準備

- [Bun](https://bun.sh/docs/installation) 1.4.4 以上。
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
4. 每個外掛都能載入、沒有兩個外掛同名，而且註冊內容有效（`Roundtable.check()`）。
5. `access` 服務哪些人：列出 owner；主機有不只一個 surface、又寫了 `everyone: true` 時提出警告，因為它會讓每個 surface 上的所有人都能對話。
6. 有沒有外掛填了 `images` 槽位。沒有也不算失敗，智慧體的頭像是組合出來的角色，不再靠它繪製。
7. `canvas` 能不能把 SVG 轉成圖片；agent 伺服器畫智慧體的圖片需要它。
8. PostgreSQL 連得上，且能執行 migration。
9. principal：預演下次啟動會從資料庫已知的人建立哪些 principal，印出的文字和啟動時的 log 相同；設定裡 owner 的身分若連到別的 principal 就判定失敗，因為主機會因此無法啟動；owner 被停用時提出警告。
10. 有設定 Discord 時：Discord token 有效、bot 已在你的伺服器裡、Message Content intent 已開啟，而且 bot 在入口頻道有它需要的權限（包含 Pin Messages）。
   bot 還不在伺服器裡的話，它會給你一個邀請連結，連結已經帶好這些權限。
11. 模型登入存在。
12. 設了 `http.publicUrl` 時：`PUBLIC_URL` 的格式正確；加上 `--reachable` 還要求它有回應，所以 bot 得先跑起來。

只要有一項失敗就以非零狀態結束，警告不算失敗；檢查過程不會改動任何東西。
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
設定裡沒有 `discord`、`plugins` 列了 `webChat({ ... })` 的主機，就是只有網頁的騎士；`roundtable init --adapter web` 會建立這種專案。

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

## 官方套件

這個 repository 裡有八個套件與核心同步發版：上面的 webchat 和 mcp，加上 [browser](packages/browser)、[coding](packages/coding)、[drawing](packages/drawing)、[line](packages/line)、[sandbox](packages/sandbox) 和 [web](packages/web)。
[外掛指南](docs/plugins.md#official-plugins)（英文）說明每一個套件和它需要什麼。

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

一輪預設工作 10 分鐘後會問你要不要繼續，總共最多 30 分鐘；用 `turnLimits` 與 `autonomy` 調整。切到長時間執行模式的對話，會自己繼續，直到 `autonomy.longRunning.maxSeconds`：

| 設定 | 預設 | 說明 |
| --- | --- | --- |
| `turnLimits.timeoutSeconds` | `600` | 一輪在卡片詢問是否繼續之前的工作時間，60 到 86400；插入這一輪的每則訊息都會重新計時 |
| `turnLimits.maxSeconds` | `timeoutSeconds` 的三倍 | 一輪總共最多工作多久，不得小於 `timeoutSeconds` |
| `turnLimits.cardSeconds` | `300` | 那張卡片等你回答多久，30 到 3600；時間到沒回答，這一輪就停止 |
| `autonomy.longRunning.maxSeconds` | `14400`（4 小時） | 長時間執行對話的一輪，工作到這個上限才會詢問或停止，600 到 604800 |
| `autonomy.yolo.allow`、`autonomy.yolo.card` | 無 | yolo 模式在預設之外可以核准的 hold 類別（例如 `shell.rm`），以及它也核准其呼叫的規則名稱（該規則沒有回報類別，例如 `tool:repo_push`），以及它永遠不核准的類別或規則名稱（例如 `shell.push`）。預設下 yolo 會核准一般的 `git push` 和工作區以外的寫入，其餘破壞性的 shell 類別仍然出卡；見[外掛指南](docs/plugins.md#hold-classes-and-yolo-mode) |

沒有 `discord` 時，只要 `agents` 列了 agent，它們就在支援房間的 surface（例如 pi-roundtable-web）裡運作；沒有任何 surface 支援房間時 host 拒絕啟動：

| 設定 | 預設 | 說明 |
| --- | --- | --- |
| `agents` | 無 | 第一批團隊，只建立一次。沒有 `discord` 時，種子沒有 `channelId`，團隊的資料列記在 id `local` 之下 |
| `coordinator` | `agents` 的第一位 | 沒有 `discord` 時，接手主人一般請求的 agent，不能被封存。有 `discord` 時設它會出錯：由入口頻道的 agent 協調 |
| `skills` | 有 `agents` 時開啟 | 技能 addon；沒有 `discord` 時，只有 `agents` 列了 agent 才會開 |
| `helpers` | 每位騎士 4 位、全站 12 位，結束 24 小時後封存 | 臨時騎士：騎士用 `helper_create` 為單一任務做出、完成後用 `helper_end` 清掉的幫手。設定為 `{ perParent, perHost, archiveFinishedAfterHours }`；`false` 兩個工具都不提供 |

沒有人在等的工作（外部 webhook 在 agent 頻道的貼文、沒指定對話的 `message_agent` 呼叫、agent 的開場任務、錯誤回報）照舊落在原本的地方，除非選填的 `routing` 區塊另有指定。
它指定每個 agent 的 primary place、每種事件送到哪個 surface，以及 host 的具名 place（例如 `ops`）；訊息、卡片、排程的觸發不會被改道，一律留在當事人所在的地方。
例如讓 Infra 的警報在網頁 app 處理，Discord 保留原始貼文：

```ts
routing: {
	agents: { infra: { primary: "app", integration: "primary" } },
	places: { ops: { agent: "infra" } }, // 取代已棄用的最上層 `ops`
},
```

寫錯會讓啟動中止，並指出鍵與修法。
每個鍵、它的值與檢查項目見[設定頁](https://pi-roundtable.wayneh.tw/zh-tw/configure/settings/)。

有人在 agent 的頻道對騎士說話時，那一輪也會讀進騎士上次在該頻道發言之後的頻道訊息（頻道脈絡；見[外掛指南](docs/plugins.md#channel-context-what-was-said-around-an-addressed-message)）。
用 `discord.channelContext` 調整，或設 `channelContext: false` 關閉：

| `discord.channelContext` | 預設 | 說明 |
| --- | --- | --- |
| `fetch` | `50` | 在被呼叫的訊息之前抓取的訊息數，最多 100 |
| `keep` | `15` | 保留的訊息數，取最新的 |
| `similarity` | `0.8` | 同一作者相鄰兩則訊息相似到什麼程度算同一則 |
| `messageChars` | `500` | 訊息截斷的長度 |
| `botMessageChars` | `80` | 其他 bot 訊息截斷的長度 |
| `foreignWebhook` | 無 | `(webhookId) => boolean \| "skip"`：回傳 true 的 webhook 所發的貼文視為別人的訊息，不是騎士自己的；回傳 `"skip"` 則把該 webhook 的貼文當作不存在，不納入也不截斷範圍（只能用程式碼設定） |
| `attachments` | `{ images: 0, maxBytes: 10 MiB }` | `images`：替這一輪抓取保留訊息中的幾張圖片，最多 4 張 |

預設騎士不理會其他 bot。要讓不同的 bot 互相對話，在 `discord.peerBots` 用使用者 id 列出要回應的 bot：

| `discord.peerBots` | 預設 | 說明 |
| --- | --- | --- |
| `allow` | 無 | bot 的使用者 id，可寫成字串，或寫成 `{ id, guilds?, channels? }` 限定伺服器或頻道。只接受明確的 id：沒有萬用字元，也沒有「所有 bot」，id 不對會讓啟動失敗。名單內 bot 的提及或回覆，會像訪客一樣被回應，能用到什麼程度由 `access` 決定 |
| `maxRounds` | `3` | 同一頻道連續回應名單內 bot 訊息的次數；有人說話就重新計算 |

在伺服器頻道或討論串裡重新開始對話時，騎士會在那裡貼一條簡短的分隔線，讓下一輪不讀之前的內容；私訊不貼。

| `discord.freshMarker` | 預設 | 說明 |
| --- | --- | --- |
| 文字 | `─── new conversation ───` | 分隔線的文字 |
| `false` | | 不貼分隔線 |

| `discord.formatting` | 預設 | 說明 |
| --- | --- | --- |
| 文字 | Markdown 會轉成排版，表格除外 | 以英文告訴模型回覆在 Discord 裡怎麼呈現；附加在每個在那裡回覆的回合的系統提示後面 |
| `false` | | 不告訴模型任何事 |

核准卡和 `ask_user` 問題（一次最多四題的一組問題放在同一張卡片上）會讓這一輪等 `discord.cardGraceSeconds` 秒（預設 `120`）。
在這段時間內回答，這一輪就帶著答案繼續；沒回答的話，這一輪會說它在等你，然後結束，卡片繼續開著、沒有期限，之後再回答就會在同一個對話開新的一輪，帶上你的答案，或核准後那個動作的結果。
coding worker 的卡片則會讓 worker 一直等下去。
每張 `ask_user` 卡片在送出旁邊都有**取消**按鈕：在這一輪還在等的時候按下，模型會被告知你取消了這個問題、不要再問一次。
一輪執行到時間上限（內建 runtime 的預算，預設 10 分鐘，或上限，預設 30 分鐘；見 `turnLimits`）時，會先問再結束：卡片寫出是哪個上限與這一輪正在做什麼，附**繼續**和**取消**；在 `turnLimits.cardSeconds`（預設 5 分鐘）內沒回答就中止這一輪。
核准卡「複製」按鈕的文字存在資料目錄的 `card-copies.json`，預設留最新 100 張、30 天；`discord.cardCopies`（`{ keepDays?, keep? }`）可以調整，設成 `false` 則只留在記憶體。
agent 頻道裡訊息的附件，整則訊息（連同它回覆的那則）要在 `discord.attachmentDownload.deadlineMs`（預設 60,000）毫秒內下載完；單一檔案連續 `discord.attachmentDownload.idleMs`（預設 10,000）毫秒沒收到任何位元組就放棄，這一輪會略過收不到的檔案繼續。

## 威脅模型

pi-roundtable 為一位擁有者執行騎士。
0.9 加入以 principal 為範圍的記憶和私人對話隔離，但模型憑證與主機執行權限仍然共用，還不是完整的多使用者服務；開放給別人使用的風險仍由營運者承擔。

- **信任誰。** 營運者掌控主機、設定和憑證。principal 代表主機服務的人，identity 是連到這個人的帳號或憑證。擁有者只能由 `access.owners` 或 `roundtable principal` 授予，不能來自 token claim。其他人的 `member` 或 `admin` tier 由核心 `access` 依驗證過的身分與帶 surface 前綴的角色判斷；外掛不能自行指定發言者的權限。
- **一輪能做什麼。** 一輪只拿得到發言者的 tier 允許的工具；沒有外掛給 tier 的工具只有擁有者能用。工具在主機的行程裡執行，用的是主機的檔案和網路：`web_search` 和 `fetch_content` 連得到內部位址，所以網頁人格要在 `selection` 裡寫明它的工具。外掛也在同一個行程裡執行，權限一樣。
- **核准。** 暫緩的呼叫只由當輪暫緩它的發言者核准，而且當下 tier 仍要足夠；在共用對話裡，擁有者也可以在卡片上或用確認訊息核准。私人對話裡別人都不能核准，高於發言者 tier 的呼叫在那裡也不會被核准。
- **對話。** Discord 裡智慧體的頻道和群組房間是共用的：在那裡發言的每個人，都會寫進智慧體讀取的同一段對話。網頁聊天的對話屬於開啟它的人：在網頁聊天裡只有開啟者本人能讀、能發言、能回答它的提問，但擁有者可以透過擁有者主控台（[pi-roundtable-web](packages/web)）讀取，營運者也能從資料庫和資料目錄讀到。
- **記憶隔離。** 記憶依 principal 分開，不依擁有者 tier 判斷。私人對話讀本人的，共用對話讀當輪發言者的；連結 Discord 與網頁身分後，同一個人共用一份記憶。在共用對話送給模型的請求和摘要裡，記憶工具與載入記憶的 worker 的呼叫（參數和結果成對）會對其他發言者隱藏，先前回合的 reasoning 則依 provider 清除。其他工具的參數和公開的騎士回覆仍是公開內容，即使模型在裡面重述私人記憶；這不是一般的秘密流向防護。第三方摘要器必須先使用 `privateCompaction`，才能摘要共用歷史。`claude-bridge` 的共用回合只在原始讀者紀錄（含已壓縮的回合）顯示另一位讀者的私人記憶（連只放進 prompt 的記憶與其 reasoning 也算），或某個呼叫已對當前讀者隱藏時才被拒絕。沒有私人記憶的回合不會擋其他讀者，關掉之後的記憶也繞不過先前的私人歷史；開放其他人進來只會在開機和 doctor 裡警告。SYSTEM 只在這項核心防護裡算作主要擁有者，所以它能讀取並公開重述擁有者保留的呼叫與 reasoning；0.9 之前、第一筆範圍紀錄之前未標記的內建記憶結果，仍歸屬擁有者。沙盒的全場共用 prompt 區塊必須明確使用 `memory.visibility: "shared"`，私人回合需要 worker 能力。Bridge 會在這些投影之外重播未過濾的歷史；見[確切規則與剩餘風險](docs/migration-0.9.md#claude-bridge-guard)。
- **模型憑證。** 每一輪不論誰發言，都用主機的模型登入執行、由它計費。每個人自己的憑證預計在之後的版本加入。
- **資料。** 對話、記憶和排程以未加密的形式存在 PostgreSQL 和資料目錄裡。

## 升級

[升級到 0.9](docs/migration-0.9.md)（英文）說明 principal 回填、明確的發言者、套件遷移、記憶隔離範圍、prompt 差異和回退方式。
一般單一擁有者的 Discord 主機可以保留舊設定；直接呼叫 runtime 的外掛和網頁整合則有必要的遷移步驟。
[升級到 0.8](docs/migrating-0.8.md)（英文）說明怎麼把 0.7 的 Discord 專案升級（不需要改設定），以及怎麼啟動沒有 Discord 的主機。

## 指令

| 指令 | 作用 |
| --- | --- |
| `roundtable init [dir] [--adapter discord\|web]` | 在 `dir`（預設為目前目錄）建立專案，透過 Discord（預設）或 pi-roundtable-webchat 對話 |
| `roundtable doctor [--reachable]` | 檢查設定，並說明如何修正有問題的地方 |
| `roundtable start` | 先執行不需要網路的檢查，再啟動 bot |
| `roundtable add plugin <name>` | 新增 `plugins/<name>.ts` 和它的測試，並列進設定 |
| `roundtable add package <spec>` | 用 `bun add` 安裝 Pi package，並新增一個載入它、把它的工具交給每一輪 agent 的外掛 |
| `roundtable upgrade [--write [--unchecked]]` | 以 diff 顯示改寫成 0.9 寫法的 `roundtable.config.ts`（`owner` 與 `speakers` 改成 `access`，`discord` 改成 adapter）；加上 `--write` 時，先確認改寫後服務的人不變（這需要主機執行時的環境變數），無法確認就拒絕寫入；`--unchecked` 不確認直接寫入，並印出警告 |
| `roundtable principal list\|show\|create\|link\|unlink\|grant\|revoke\|disable\|enable` | 列出並修改資料庫裡的 principal、它們的身分與角色；執行中的主機在 30 秒內看到變更 |

## 變更與授權

[CHANGELOG.md](CHANGELOG.md)（英文）列出套件匯出名稱的每一項變更。
[MIT](LICENSE)。
