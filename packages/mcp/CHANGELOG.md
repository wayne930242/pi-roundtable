# Changelog

All notable changes to this project will be documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- `remoteMcp({ principal })`: the id of the principal the dispatch token stands for, the primary owner by default, as in 0.8. The plugin declares the token as the identity `token:<toolNames.dispatch, or remote-mcp>` in its `identities`, which the host links to that principal at every start; a principal that does not exist, or the identity linked to someone else, stops the start.
- `RemoteMcpMessages.memberRelayNote`: the note opening each relayed message when the token stands for someone who is not an owner; it falls back to a `relayNote` you give.

### Changed

- The connector form of `/<root> connector add` is accepted from every owner, as pi-roundtable's `CommandGuard.allows` sees them, not only the primary owner.
- A default remote turn is the bound principal's, from `IDENTITY.speakerFor`, at their tier, and its conversation is recorded as private to them. Bound to the primary owner, as by default, the speaker is the owner's principal at the owner tier, so the prompt, memory, and tools are 0.8's; bound to a member, the turn reads their memory and offers only their tier's tools, and the persona and relay note name no owner. The host's own `answer` receives that speaker as a third argument.
- `remoteMcp` requires `IDENTITY` (provided by the built-in `identity` plugin of pi-roundtable 0.9); a `testPlugin` test of it gives one with `principalOf`, `tierOf`, `speakerFor`, and `owners`.
- Each remote session belongs to the principal it was opened for (`remote_agent_sessions.principal_id`, migration `remote-sessions-principal`); after the token moves to another principal, continuing a session of the earlier one answers `SESSION_NOT_FOUND`. Sessions 0.8 opened are handed to the primary owner at the start, and their conversations, which 0.8 recorded as shared, are adopted as private to them with `CONVERSATIONS.adopt`, so a single-owner host's remote turns stay 0.8's. `remoteMcp` therefore requires `CONVERSATIONS` too, and a `testPlugin` test of it gives one with `adopt`.
- The buttons and menu of `/<root> mcp authorize` and `/<root> mcp token` check again, at each press, that whoever presses is an owner, so an owner revoked while the flow is open completes nothing.

### Deprecated

- `REMOTE_SPEAKER` in `default-conversation.ts`: remote turns are for the bound principal. It goes away in 1.0.

## [0.8.0] - 2026-10-07

- Release in lockstep with pi-roundtable 0.8.0; no package-specific behavior changes.

## [0.7.18] - 2026-10-05

### Fixed

- Reserve a remote session atomically so simultaneous dispatches cannot overlap.
- Keep a timed-out session busy until its underlying answer settles, and release it after synchronous or asynchronous answer failures.

### Changed

- Track active executions by session instead of scanning historical runs to decide whether a session is busy.

## [0.7.2] - 2026-10-02

The first release from pi-roundtable; 0.7.0 and 0.7.1 were not published for this package.

### Changed

- Move into the pi-roundtable monorepo at `packages/mcp`, preserving Git history and the public API.
- Jump from 0.4.1 to lockstep 0.7.0, peer on `>=0.7.0 <0.8.0`, and test against core 0.7.0.
- Use the shared PostgreSQL CI and single-tag publication workflow.

## [0.4.1] - 2026-10-01

### Changed

- The peer dependency on `pi-roundtable` is `>=0.4.0 <0.6.0`, so a host on 0.5 does not get a peer warning. The tests now run against pi-roundtable 0.5.0.

## [0.4.0] - 2026-10-01

### Added

- `ChannelGrantStore` is exported, with its `migration`, `attach(sql)`, `ensureBundle`, `save` and the rest, for host-side imports and tools. The plugin still owns the tables.
- `ConnectorMessages`: the ContextForge errors are messages now (`upstreamUrlUnreadable`, `contextForgeNoGatewayId`, `contextForgeNoServerId`, `contextForgeRefused`, `contextForgeNotJson`, `virtualServerRequestFailed`, `virtualServerMissing`, `virtualServerNoTools`), and so are the description of a new connector's virtual server (`serverDescription`) and the separator after a connector's name in the list (`labelSeparator`). The values they receive are masked as before.
- `RemoteMcpMessages`: the human part of a granted tool's error (`operationFailed`, `outcomeUnrecorded`, and `codeDetail`, which joins it to the fixed code), the label and list separators of the grants list (`labelSeparator`, `listSeparator`), and the wording of an audit entry's status (`auditStatus`).
- `RemoteMcpMessages.describeAgentNameOption` and `revokeNotInBundle`: the `name` option of `describe` and the refusal of `revoke` have their own wording. They default to the text of `agentNameOption` and `notInBundle`.

### Changed

- `agentNameOption` now words only the `name` option of `authorize`, and `notInBundle` only what `describe` says when the channel is not in the bundle. The English defaults are unchanged, so a host that overrides `messages` keeps working; it sets the new keys where it wants a different wording.
- `runGrantedTool` takes the messages as its last argument. It is internal and not exported from the package.

## [0.3.0] - 2026-10-01

### Added

- `Connectors.resolve(serverName)` reads a virtual server by name, and `Connectors.admin` (`gateways()`, `servers()`) shows what ContextForge holds, for a host that manages some servers itself or shows their state.
- The `REMOTE_MCP` service of `remoteMcp`: the owner's bundles and grants, read only, and `describeGrant(client, grant)`, so a host can show them in its own status view.
- The types `GatewayState`, `ChannelBundle`, `ChannelGrant`, and `RemoteMcpService`.

## [0.2.0] - 2026-10-01

### Added

- `remoteMcp({ toolNames })`: the names of the two tools at `/mcp/personal`, for agents that are already set up with other names. The default descriptions name each other with the chosen names. A name that is not letters, digits, `_` or `-` (up to 64), or two equal names, is refused when the plugin is created.

### Changed

- `RemoteMcpMessages.dispatchDescription` and `resultDescription` are now functions that receive the tool names, so a description can refer to the other tool by its real name. A host that set either as a string gives `() => "..."` instead.

## [0.1.0] - 2026-10-01

First release: two plugins for pi-roundtable 0.4, extracted from a private host.

### Added

- `mcpConnectors(options)`: the owner's MCP connectors through ContextForge. `/<root> connector add | list | describe | remove` manage them from Discord, with a private form for the token. It provides the `CONNECTORS` service (`version`, `list()`, `servers()`, `profileSources()`, and the ContextForge `token`), so a host builds its per-agent MCP profiles itself. Options: `contextForge` (`url`, `jwtSecret`, `user`), `serverPrefix` (default `roundtable-conn-`), `maxToolName` (default 45), and `messages`.
- `remoteMcp(options)`: an MCP server over HTTP on the host's `public` listener for agents outside Discord. `/mcp/personal` relays turns to the owner's agent (`agent_dispatch`, `agent_result`); `/mcp/discord/<token>` offers the Discord channel tools granted to one bundle. `/<root> mcp authorize | grants | revoke | describe | token` grant channels on Discord. Idle remote sessions are deleted after 14 days.
- Without `answer` and `claim`, `remoteMcp` runs a relayed turn on the core: `context.turns.run` of kind `remote` for an owner-tier speaker, with a `remote` persona (`persona` option, a short neutral prompt by default). A host that runs the owner's conversations itself gives `answer` and `claim` together.
- A `messages` option on both plugins; the English text is the default. pi-roundtable's message catalog is closed to plugins, so these plugins carry their own.
- The types `Connector`, `ConnectorProfileSource`, `Connectors`, `ConnectorMessages`, `RemoteMcpMessages`, `RemoteClaimHooks`, and the option types.
