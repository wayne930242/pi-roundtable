---
type: Added
packages: [mcp]
---
`ConnectorRegistry.resync(name)` and `resyncAll()`, on `CONNECTORS` as `resync(name)` and `resyncAll()` and on Discord as `/<root> connector resync [name]`. A resync has the gateway read the connector's upstream server again, then sets its virtual server's tools to the gateway's current ones (names longer than `maxToolName` are skipped and reported as at add) and reads their hints, so an upstream that renamed tools is picked up, each renamed tool with the hints its upstream gives it, without removing the connector and entering its token again. A tool that keeps its name keeps the hints the gateway first stored for it, because the gateway's refresh does not update them: for hints that changed upstream under the same name, remove and add the connector again, or set the hints on the gateway. The gateway, the virtual server, the token, the purpose and the stored row stay; `version` changes when the tools or their hints did. Resyncs run one at a time.

A failure before the gateway reads the upstream leaves the connector as it was. The gateway's own refresh drops the tools the upstream no longer offers from the virtual server, so a failure after it (the upstream offers no usable tool, or a later request fails) may leave the virtual server with fewer tools until the next resync; it is logged as such. Until the new tools are read back, the connector lists both the old and the new tool names with their hints, so the `mcp-hints` rule holds a renamed destructive tool even when the read-back fails.

A resync makes five admin requests per connector and spaces them by `resyncIntervalMs` (default 1200, 50 a minute, half of the gateway's limit of 100 a minute, which locks the admin account for 15 minutes when exceeded; 0 turns pacing off). When the gateway answers 429, or 401, 403 or 423 (the account refused or locked), `resyncAll` stops there without retrying: the connector that met it and the ones after it are reported as not resynced, a single `resync` fails with `ConnectorRateLimited`, and every resync is refused without a request for `resyncLockoutMs` (default 15 minutes).

The gateway's admin client gains `refreshGateway` and `setServerTools`, its tool type optional `gatewayId` and `hints`, its error type an optional `status`, and `ConnectorMessages` the keys `resyncDescription`, `resyncNameOption`, `resyncedTitle`, `resyncedAllTitle`, `resyncedFooter`, `resyncChanges`, `resyncUnchanged`, `resyncFailed`, `resyncNotAttempted` and the gateway's refresh-failure message. `ConnectorRateLimited` is exported.

**Breaking for hosts that implement `Connectors`:** the type gains `resync` and `resyncAll`, which such a host needs to provide.

`mcpConnectors` resyncs every stored connector in its preflight, after loading them, at that pace. A failure is logged. The `listFooter` text mentions `resync`.
