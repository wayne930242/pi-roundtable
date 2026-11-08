// Replies the fixture host's scripted agents give.

/** The reply to a message that starts with no keyword. */
export const SAMPLE = `Here is a quick look at what I can do for you today:

- **Plan the week.** I keep your calendar and the notes you share with me.
- **Run things for you.** Anything that changes a system asks first.
- **Answer questions** with sources.

\`\`\`bash
bun run deploy --env staging
\`\`\`

| Task | Status |
| --- | --- |
| Backups | done |
| Release notes | drafting |

Ask me for a *demo* with \`approve\`, \`ask\`, \`quiz\`, \`timeout\`, \`late\` or \`stream\`.`;

/** A reply with a block of every kind the app draws, between lines of Markdown. */
export const BLOCKS_REPLY = `Here is the release status. Everything is on track except one step.

> [!WARNING] Heads up
> The cache is **overwritten** on release; back it up first. See [the runbook](https://example.com/runbook).

\`\`\`cards
- {title: Speed, tone: ok, body: "**2x** faster than the old path"}
- {title: Risk, tone: warn, body: Needs a migration window}
- {title: Cost, tone: risk, body: Doubles the cache memory}
\`\`\`

\`\`\`table
columns:
  - name
  - {name: size, label: Size, type: number}
  - {name: day, label: Shipped, type: date}
rows:
  - [alpha, 1204, 2026-03-01]
  - [beta, 2, 2026-01-15]
  - [gamma, 87, 2026-02-09]
sort: -size
filter: true
\`\`\`

\`\`\`steps
items:
  - {title: Design, status: done, when: Mon}
  - {title: Build, status: doing, when: Tue, body: "Two of **four** services left"}
  - {title: Legal review, status: blocked, body: Waiting on the vendor}
  - {title: Ship, status: todo}
\`\`\`

\`\`\`stats
- {label: Users, value: "1,204", delta: "+4%", tone: ok}
- {label: Errors, value: "3", delta: "-2", tone: ok, note: last hour}
- {label: Latency p95, value: 420 ms, delta: "+60 ms", tone: risk}
\`\`\`

\`\`\`mindmap
- Release
  - Build
    - bundle
    - sign
  - Ship
    - tag
    - announce
\`\`\`

\`\`\`mermaid
graph TD
  A[Start] --> B{Ok?}
  B -->|yes| C[Done]
  B -->|no| D[Fix]
  D --> B
\`\`\`

\`\`\`diff
--- a/cache.ts
+++ b/cache.ts
@@ -1,3 +1,4 @@
 export function get(key: string) {
-  return store.get(key);
+  const hit = store.get(key);
+  return hit ?? load(key);
 }
\`\`\`

\`\`\`options
- {title: SQLite, recommended: true, body: Embedded, pros: [no server], cons: [one writer]}
- {title: Postgres, body: A server to run, pros: [many writers], cons: [more to operate]}
\`\`\`

\`\`\`form
title: Decide the store
submit: Send decision
questions:
  - {name: store, label: Which store?, required: true, choices: [{value: sqlite, label: SQLite}, {value: pg, label: Postgres}]}
  - {name: extras, label: Which extras?, type: multi, required: true, choices: [{value: cache, label: Cache}, {value: queue, label: Queue}, {value: search, label: Search}]}
  - {name: note, label: Anything else?, type: text}
\`\`\`

\`\`\`checklist
title: Before the release
items:
  - {name: tests, label: Tests pass, checked: true}
  - {name: docs, label: Docs are updated}
  - {name: notes, label: Release notes are written}
\`\`\`

\`\`\`suggest
- Ship it
- Wait for the vendor
- {label: Ask Ada, text: Please ask Ada to decide}
\`\`\`

\`\`\`review
title: Two logo drafts
pick: Favourite
items:
  - {name: A, body: Round and warm}
  - {name: B, body: Sharp and cold, page: draft-b.html}
\`\`\`

The last five blocks are answered here: the answer is sent to me as your next message.`;
