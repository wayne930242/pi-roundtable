# Changelog

All notable changes to this project will be documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

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
