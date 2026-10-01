# Changelog

All notable changes to this project will be documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.1.0] - 2026-10-01

First release: two plugins for pi-roundtable 0.4, extracted from a private host.

### Added

- `mcpConnectors(options)`: the owner's MCP connectors through ContextForge. `/<root> connector add | list | describe | remove` manage them from Discord, with a private form for the token. It provides the `CONNECTORS` service (`version`, `list()`, `servers()`, `profileSources()`, and the ContextForge `token`), so a host builds its per-agent MCP profiles itself. Options: `contextForge` (`url`, `jwtSecret`, `user`), `serverPrefix` (default `roundtable-conn-`), `maxToolName` (default 45), and `messages`.
- `remoteMcp(options)`: an MCP server over HTTP on the host's `public` listener for agents outside Discord. `/mcp/personal` relays turns to the owner's agent (`agent_dispatch`, `agent_result`); `/mcp/discord/<token>` offers the Discord channel tools granted to one bundle. `/<root> mcp authorize | grants | revoke | describe | token` grant channels on Discord. Idle remote sessions are deleted after 14 days.
- Without `answer` and `claim`, `remoteMcp` runs a relayed turn on the core: `context.turns.run` of kind `remote` for an owner-tier speaker, with a `remote` persona (`persona` option, a short neutral prompt by default). A host that runs the owner's conversations itself gives `answer` and `claim` together.
- A `messages` option on both plugins; the English text is the default. pi-roundtable's message catalog is closed to plugins, so these plugins carry their own.
- The types `Connector`, `ConnectorProfileSource`, `Connectors`, `ConnectorMessages`, `RemoteMcpMessages`, `RemoteClaimHooks`, and the option types.
