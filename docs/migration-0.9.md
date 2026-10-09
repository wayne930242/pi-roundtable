# Migrating to 0.9

0.9 makes the person behind a turn explicit: a **principal** owns memory, private conversations, schedules, and notifications, while an **identity** is an account or credential linked to that principal.
`Speaker.id` remains the external actor id; the required `Speaker.principalId` identifies the person.
This is principal isolation, not a claim of a complete multi-user service: model credentials, host files, and plugin execution remain shared.

## Who needs to act

An ordinary single-owner Discord host using only the built-in conversation paths needs no configuration or data edits.
Its old `owner` and `speakers` settings still work with a deprecation warning, the owner's principal keeps their old id, and their memory and schedules stay theirs.
Back up the configuration, PostgreSQL, and the data directory before upgrading, run `roundtable doctor`, and check the first boot's identity backfill log.

You must act if you:

- Call `runtime.runTurn` yourself, construct speakers or background turns, implement a surface, or replace a core service port: see [plugin changes](#plugin-changes).
- Contribute a background target named `"owner"`: the core now contributes it on every host, so remove your duplicate.
- Use webchat's old `access` option: move it to the core configuration.
- Use the web console with a verifier reporting an actor: link its identity to an owner, even on a single-owner host.
- Use memory and a `claude-bridge` model in shared conversations: review the history-based turn guard and remaining risks below before admitting new readers.
  A host whose agents' channels admit anyone but its owners (admins or members who talk to the agents) on `claude-bridge` should set `discord: { agentMemory: "owners" }`: a guest's turn then loads no memory, so it never makes the guard refuse the owner afterwards. It does not let the guest speak after the owner's memory turns; see the [bridge guard](#claude-bridge-guard).
- Do not want an agent's channel turn to read the server channel's other messages: set `discord: { channelContext: false }` (see [channel context](#channel-context)).
- Rely on system error or webhook report turns to schedule or delegate: they may no longer create, change, or cancel schedules, delegate tasks, or call coding's `repo_task`; they may still list schedules.

## Upgrade the configuration

Run these from the host project, with the environment its configuration normally loads:

```sh
bunx roundtable upgrade
bunx roundtable upgrade --write
bunx roundtable doctor
```

The first command previews a diff without changing files.
`--write` checks that the rewritten configuration serves the same people and then writes only `roundtable.config.ts`.
It converts `owner` and `speakers` to `access`, keeps the owner's old id as their `principal`, prefixes identities and roles, scopes old `everyone` to Discord, and moves top-level `discord` to `adapters: [discord(...)]` with its import.
A second run has no diff.
Dynamic objects or spreads it cannot safely rewrite need manual edits at the reported line.
If the configuration cannot load for the equivalence check, provide its normal environment; `--write --unchecked` is an explicit opt-out with a warning, not the recommended path.
It does not update plugin source, webchat options, or credentials.
Do not combine `access` with old `owner` or `speakers`: the host refuses that configuration.
The first configured owner is the primary owner and needs an explicit principal id; Discord also needs their linked Discord identity.

Use `roundtable principal list` and `show` to inspect principals and copy identity strings.
`link <principal> <identity>` links another account to the same person's memory; `grant`, `revoke`, `disable`, and `enable` manage lasting roles and admission.
CLI changes can take up to 30 seconds to reach a running host's identity cache.
Only configuration and CLI grants confer owner; IdP roles never do.
`provisioning: "admitted"` creates a principal for a newly admitted person; `"linked"` accepts only existing links and does not claim old ids.

## Data migration and conversation ownership

The boot migrations add identity tables and held-action attribution without rewriting existing conversation, memory, or schedule rows.
The backfill creates principals with the old person ids; an adapter's verified first contact can claim a backfilled id once.
A principal created normally, one already linked, or a configured owner is not a new identity's legacy claim.
Unlinking an identity does not restore that claim.
The 0.8 `remote-mcp` author is attributed to the primary owner, including their existing schedules, not made into a separate member.
An old non-owner schedule author gets an initial last-seen tier capped by current access rules and a 30-day background window by default.
Background execution still caps the recorded tier at current lasting roles, or at the last admitted tier for someone whose roles come only from the IdP; after `access.backgroundStaleDays` (default 30), those IdP-only background turns are skipped until the person returns.
Disabled, unknown, or unadmitted principals are skipped too.

Register a private conversation with `CONVERSATIONS` **before the first runtime call**, including a transcript read.
Registration fixes ownership on the first record; later registration does not change it.
Use `CONVERSATIONS.adopt(key, principalId)` only to migrate a pre-0.9 shared record with no principal that your plugin knows was one person's conversation.
Adoption is idempotent and does not change an existing private record; adoption of conversations created in 0.9 is outside its contract and may be refused in a later release.
Remote MCP performs this migration for its old sessions.
Other 0.8 shared rows stay shared: even a single owner's formerly shared room now uses "the speaker" tool wording.

Never flip visibility or transfer a conversation to reuse its history.
If its effective scope changes (private to another principal, private to shared, or shared to private), the runtime archives the old history, drops held actions, and starts an isolated session; this applies after a restart too.
An explicit `TurnRequest.conversation` should agree with your registry's ownership.
A private conversation refuses another principal's interactive turn both through `context.turns` and through the Pi runtime directly.
Private prompts never escalate to an owner; a held call above the person's tier expires without being shown.
In shared conversations, the principal who spoke may answer from any linked identity at the required tier, and owners may answer escalated prompts.

## Plugin changes

- `TurnRequest.speaker` is required.
  `runTurn` without one returns `{ ok: false, error }` with an `AgentRunError` before asking the model; obtain it with `IDENTITY.speakerFor(principalId)` rather than assuming owner tier.
  `kind: "owner"` selects a persona, not authority.
- `BackgroundTurn.author` needs `{ principalId, id, name }`, and the turn needs an explicit `tier`.
  Old shapes missing principal or tier are skipped with a reason, not elevated to owner.
  A background claim runs as the router-checked `turn.speaker`.
  Plugins cannot manufacture `SYSTEM_PRINCIPAL` turns; only core report paths do so.
- `PERSONAL_TARGET` replaces the deprecated `OWNER_TARGET` export (the same object until 1.0).
  Its persisted name remains `"owner"`; remove a plugin's own target with that name to avoid a duplicate.
  Configure optional cross-conversation limits with `background.perPrincipal.schedules` and `delegations`; neither has a default cap.
- `OwnerPrompts` is a deprecated alias of `Prompts` until 1.0.
  A surface receives `PromptScope`, with `principalId`, `speakerId`, `tier`, and `escalate`, rather than treating every prompt as the primary owner's.
  Old `prompts(channel, speaker)` calls remain accepted with a warning, interpreted as shared scope.
- `notify_owner` becomes `notify`.
  Until 1.0 the old name works in selections, profiles, task exclusions, required tools, and tool-tier overrides, with a warning; models see the new tool name.
  Notices go to the private conversation's person, or the current speaker in a shared conversation, through contributed direct channels.
- Internal prompt naming changes from `ownerWords` to `addresseeWords`, with the old internal alias retained; neither is a public package export.
  Consumers should use the public `SessionContext.addressee` rather than importing core paths.
  Synchronous `CommandGuard.isOwner` is deprecated and tests only the primary owner's actor id; use asynchronous `allows(actor)` to check every owner now.
- Surfaces report verified `ActorFacts`; only the router sets `InboundMessage.speaker` before admission.
  A surface-supplied speaker is overwritten.
  Old author fields remain a warned fallback until 1.0; no tier means no admitted person, not owner.
- A plugin's `identities: [{ identity, principal? }]` binds only `token:` credentials, defaulting to the primary owner.
  Surface accounts must be linked in configuration or by CLI, not declared by plugins.
  A conflicting or unknown principal stops boot; removing a declaration unlinks its plugin-owned token on the next boot.
  Bind a token to a non-owner only after giving that principal a lasting CLI role: remote turns do not refresh IdP last-seen admission.
- Stand-in ports must implement the new methods of their interfaces (including registry `adopt`, conversation `runsAs`/`takesSystemReports`, and schedule-store `createWithin`).
  A manually built `SessionContext` supplies `conversation`, `addressee`, and `memory`; tasks inherit the resolved memory policy and need a parent turn's tier.

See [Principals and access](plugins.md#principals-and-access) for a tested example.
Scheduling and delegation tools are present only where a background claim can answer; a no-surface session must already be registered private to a person a direct channel knows.
`DirectChannelProvider.knows` is a local capability check; actual delivery and claim reachability are rechecked when the tool runs.

## Memory isolation and compactors

Memory is keyed by principal, never by owner tier.
Private sessions use their person's memory; shared turns project only the current speaker's memory into the request, non-persistently, and system turns in a shared session load none.
`Persona.memory: "none"` disables both memory tools and the memory prompt, including its workers.

In shared history, the isolation guarantee covers the **arguments and results together** of memory-tool calls and calls whose workers loaded a person's memory (including their enclosing exchanges).
Those exchanges are hidden from other speakers, including system turns, and from compaction summaries.
Earlier reasoning is removed with provider-aware handling of thinking blocks, encrypted reasoning, signatures, and paired message/call ids; the current turn keeps its reasoning.
User messages, public assistant replies, and arguments/results of other tools remain public: the model can disclose something it knows in them, so do not treat this as general secret-flow prevention.
Owners using the console and the operator reading storage can inspect all principals' data.

Compaction registered through `session.compaction.wrap` receives a private-memory-free projection.
A third-party compactor reading shared history outside that wrapper **must call `privateCompaction(event.preparation, branchMessages)`** from `pi-roundtable/kit` before summarizing, where `branchMessages` is the message entries of `event.branchEntries` (so a private result in the kept tail can hide its earlier arguments).
A custom tool returning private data must mark its result's `details.privateTo` with the principal id, including error results that repeat private arguments.
This is independent of the tool name: the core hides both the tagged result and the arguments of its paired call, preserving the tool-call id and name.
Do not rely on tagging to protect data repeated in public assistant replies or other untagged tools.
Hosts building their own shared Pi sessions can use `memoryProjection(messages, { shared: true, reader })` and `hidesPrivateExchange(messages, view)` from `pi-roundtable/kit`; the latter checks exchanges, not reasoning/prompt changes.
A host that builds its own shared Pi session and runs it on `claude-bridge` needs the core's reader records too, because `hidesPrivateExchange` cannot see retained prompts or reasoning: call `recordMemoryTurn(manager, reader, carriesPrivatePrompt)` before each prompt, call the marker it returns when a `message_end` event passes `carriesMemory(message)`, and refuse the turn before the provider call when `bridgeHistoryHidesMemory(manager.getBranch(), reader)` is true.
`summaryProjection(messages, history?)` and `privateCompaction(preparation, additionalMessages?)` accept the surrounding history when call/result pairs cross summary-prefix-kept boundaries.

### claude-bridge guard

claude-bridge reuses Claude Code's stored, unfiltered history, bypassing the per-request projection.
Each shared core bridge turn checks the session's actual raw history before asking any provider, including after restart and when an agent switches to bridge.
The raw persisted branch is checked even for turns already removed from Pi's active context by compaction.
Every prompted turn, on any provider, appends a `roundtable-memory-turn` custom reader record: the actual principal (SYSTEM stays recorded as SYSTEM), a turn id, and whether its request carried private memory.
Loading core memory into that reader's prompt marks the turn private even if it calls no tools; any memory exchange or memory-loaded worker marks it private too.
A later private marker keeps the same turn id when memory is first used during the turn.
Malformed, schema-rejected, truncated, and aborted built-in memory calls, including calls with no result or ownership tag, are attributed to that turn's recorded reader.
An agent turn checks and uses one copied model/thinking snapshot; a setting changed during selection applies on the next turn rather than switching providers after the guard.
It returns an `AgentRunError` when a retained turn carried another reader's private memory, or an explicit `privateTo` exchange would be hidden from the current reader.
This refuses reasoning replay across readers even when the earlier turn only read memory from its prompt and used no tools: request projection cannot clean Claude Code's retained transcript.
A recorded turn that loaded no private memory never blocks another reader merely for having a different principal.
For this core replay check only, SYSTEM counts as the primary owner, for modern records and old exchanges alike: owner and SYSTEM can alternate over owner memory.
SYSTEM can therefore read the owner's raw retained private exchanges and reasoning on bridge, and can repeat them publicly; this is the retained compatibility design, not SYSTEM-private isolation.
Pre-0.9 history without reader records keeps the legacy rule: untagged built-in memory results before the first `roundtable-conversation` scope marker belong to the primary owner for the guard.
After that scope marker, an unowned result or outstanding memory call with no reader record still fails closed, including for owner and SYSTEM; with a reader record, the malformed exchange no longer locks its own reader out forever.
Request projection is unchanged: shared SYSTEM requests load no personal memory and redact everyone's private exchanges, but bridge bypasses that projection.
A conversation holding only a guest's private turns admits that guest, not the owner or SYSTEM.
Other providers and private conversations are unaffected by this guard.

In the agents' channels, `discord.agentMemory: "owners"` (default `"everyone"`) keeps a speaker below the owner tier out of memory: that turn has no memory in its prompt, no memory tools, and no memory-loading workers, so its reader record carries no private memory and a later owner or SYSTEM turn is not refused because of it.
The reverse stays: once an owner's turn has loaded memory, a guest's bridge turn in the same conversation is refused until the conversation starts fresh.

Admission of another person in configuration or stored roles is only a startup warning, and `roundtable doctor` warns rather than fails for that risk.
A guest admitted elsewhere but absent from this conversation does not block the owner's turns.
To share incompatible history, choose another provider or start a fresh conversation whose turns carry no private memory when readers differ.
`memory: false` or persona `memory: "none"` prevents future core memory loading; disabling memory does not bypass the guard or erase already recorded private history.
A reader record that is corrupt (not an object, or with an empty reader or a non-boolean `privateMemory`) cannot establish who owned its turn, so the guard fails closed: every later bridge turn in that conversation is refused, the owner's and SYSTEM's too, with the same error.
Records are written only by the runtime, so this takes an edited or damaged session file; the recovery is to start the conversation fresh (the runtime's `startFresh`, which the channel's start-over command calls), which archives the old history and opens one without the record.
Reader records are prospective: earlier prompt/reasoning states with no reader records cannot be reliably attributed, so start fresh before sharing an old private history with new readers.
The guard is not general secret-flow prevention: private data repeated in public replies, untagged custom tools, or pre-existing summaries can still reach later readers.

## Official packages

### Web console

An actor-bearing verifier must report an identity linked to a principal holding owner.
An unlinked identity receives 403 even on a one-owner host; the log gives the identity and the configuration/link instruction.
For Cloudflare Access, use `cloudflareAccessIdentity(teamDomain, sub)` in `access.owners[].identities`, or the CLI equivalent.
`legacy:` is never a console sign-in identity and is refused.
A 0.8 verifier returning `admit()` without an actor retains primary-owner compatibility with a warning, not a recommended new verifier contract.
Every admitted owner can inspect all conversations and choose any principal's notes; this is not a member self-service console.

### Webchat

Remove `webChat({ access })`, `webAccess`, and `WebAccessMap`.
Use top-level `access`, prefix roles as `<surface>:role:<name>` (default `web:role:App.User`), replace user ids with identities, and scope old `everyone: true` to `everyone: ["<surface>"]`.
Core `everyone: true` admits every surface, not only this verifier's people.
Old OIDC principals and their private conversations remain theirs; new admitted people get opaque `p_` ids.
Tickets, quotas, connection groups, and approvals now follow the principal; token refresh to a different principal closes with 4403.
The protocol remains `roundtable.webchat.v1`, with added `notice` frames and private inbox REST endpoints (`GET <path>/notices`, `POST <path>/notices/<id>/read`).
Notices are separate from conversation history and available after reconnect.
The claim declares `takesSystemReports: false`: `ops.conversation` cannot point at webchat and fails at boot; use a shared report conversation or `ops.agent`.

### MCP, coding, and sandbox

Remote MCP's token defaults to the primary owner's principal and its private conversation reads that person's memory.
Set `remoteMcp({ principal })` to bind it explicitly; `REMOTE_SPEAKER` is deprecated.
`/mcp/discord/<token>` channel grants are unchanged by this migration.
Coding's owner skill list is available only in a private conversation whose principal holds owner, not merely a turn whose kind is owner.
Sandbox ignores visitors whose resolved speaker has no tier and passes the admitted principal to its runtime; its sealed default's container/channel-shared memory contract is unchanged.
The opt-in `PiSandboxRuntime` now accepts `author.principalId` (falling back to actor `id` for legacy integrations where it is already the principal); host tool callbacks return `PiToolResponse.privateTo` to persist `details.privateTo` in the worker.
Its independently-created Pi sessions explicitly project requests and summaries, including the host compactor's kept messages, using the core helpers. Rebuild the worker image with matching upgraded core/sandbox code.
Tag every private custom-tool result and error; untagged custom tools, raw files, public replies and old summaries remain shared. See [sandbox private exchanges](../packages/sandbox/README.md#private-tool-exchanges-in-pi-mode).
`PiSandboxRuntimeOptions.memory.visibility` defaults to `"private"`: a nonempty prompt block records that reader's private memory even without tool calls.
For party-wide facts, explicitly set `memory.visibility: "shared"`, including for an upgraded 0.8 host, or another participant's next claude-bridge turn is refused.
This declares only the prompt block public; a tool's `privateTo` result remains private.
The worker performs the same raw reader-record check before its provider call, without the core's primary-owner/SYSTEM compatibility mapping.
It declares `privateTo` and `readerRecords` capabilities plus whether it holds private history at readiness; an incompatible image refuses private turns rather than silently dropping isolation.
The host requires those capabilities only for a private prompt, known private history, or an actual tagged host-tool response; empty/shared prompt blocks and public-only tools remain compatible with older images.
A first private response is withheld from an incompatible image and fails the entire turn, with an error naming the image to rebuild.
See the [worker handshake](../packages/sandbox/README.md#worker-capability-handshake).

## Channel context

New in 0.9: a turn for a message in an agent's channel also reads the channel messages posted since the assistant's last post there, including those that did not address it, such as other people's and other bots' messages.
They are appended to the turn's text as a delimited block saying they were not addressed to the assistant (each author as `from`, `id` and `role` attributes; tag-like `<` in a message's text is neutralized), so they live in the conversation's history, not in the system prompt.
It reads Discord when the turn starts, so it needs no data migration and survives restarts.
A group's round reads none, since it already carries what was said since its last turn, and direct messages never do.

The defaults fetch the 50 messages before the addressed one and keep at most the newest 15 after the assistant's latest post, merging consecutive near-repeats of one author (80% alike) and cutting long messages (500 characters, another bot's at 80).
Change them under `discord.channelContext` (`fetch`, `keep`, `similarity`, `messageChars`, `botMessageChars`), or turn it off for the host with `discord: { channelContext: false }`, in `adapters: [discord({ ... })]` or the top-level `discord`.

Channel context is public channel text: it is not private memory, is never tagged `privateTo`, and the turn's reader stays the person who addressed the assistant.
People with no tier appear in it as channel text but do not become speakers.
A plugin's claim, such as one that runs a party in its own server, opts in with `DISCORD.channelContext(message)` and `withChannelContext(text, context)` from `pi-roundtable/discord`; see [Channel context](plugins.md#channel-context-what-was-said-around-an-addressed-message).
A plugin's own stand-in `DISCORD` service needs `channelContext`; `fakeDiscord()` has it.

## Prompt changes from 0.8.0

The acceptance snapshots record these exact differences; do not expect every single-owner prompt to be byte-identical:

| Snapshot | Difference |
|---|---|
| (a) agent, (b) group seat, (c) owner's persona conversation | Only the tool name `notify_owner` becomes `notify`; system prompt, descriptions, and parameters are byte-identical. |
| (d) member in a shared persona room | `ask_user` and the three memory tools replace `Ada`/`she` with `the speaker`; `memory_remove` and `memory_search` also add "Whoever is speaking has a memory of their own…". |
| (e) direct `runTurn` without speaker | Refused; no prompt is sent. |
| (f) headless webchat-style private conversation | Byte-identical to 0.8.0; the only unchanged whole snapshot. |
| (g) web member's private conversation | The same tools no longer name the configured owner and use `the speaker`. |
| (h) agent turn with channel context | New in 0.9: the archivist's agent session, which also records the turn's own message: its text, then the [channel context](#channel-context) block. Without channel context a turn's message is its text alone, as in 0.8. |

The tool-set snapshot changes only `notify_owner` to `notify`.
For other private conversations, descriptions name their principal when known; old shared single-owner rooms retain shared "the speaker" wording until explicitly migrated where appropriate.

## Rollback and downgrade

Stop the host and all background work before a downgrade; keep the pre-upgrade configuration, package lock, database backup, and data directory together.
Restore the old source/configuration and matching official package versions.
0.8 does not understand `access`, principal CLI commands, plugin identity declarations, or webchat's new options/frames/inbox; it cannot load a 0.9 configuration unchanged.
It ignores the additional identity tables, principal attribution columns, and new session metadata; existing 0.8-shaped rows still use their old ids, and the additive migrations do not delete them.
But 0.8 cannot enforce principal-private session isolation, read the notice inbox, or safely interpret new `p_` principals/linked accounts as the original external speakers.
It also lacks the memory-history filtering and fail-closed turn checks, so **do not resume newly principal-isolated or shared sensitive conversations under 0.8**.
Restore the pre-upgrade database and session files when you need a faithful rollback, rather than expecting 0.8 to preserve new identity semantics.
If you intentionally run 0.8 on the additive schema and later re-upgrade, the every-boot backfill discovers person ids written during the downgrade without rewriting their rows; verify the resulting links and roles before reopening access.
