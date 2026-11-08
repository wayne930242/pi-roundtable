---
type: Added
packages: [mcp]
---
`ConnectorRegistry.resync(name)` and `resyncAll()`, on `CONNECTORS` as `resync(name)` and `resyncAll()` and on Discord as `/<root> connector resync [name]`. A resync has the gateway read the connector's upstream server again, then sets its virtual server's tools to the gateway's current ones (names longer than `maxToolName` are skipped and reported as at add) and re-reads their hints, so an upstream that renamed tools is picked up without removing the connector and entering its token again. The gateway, the virtual server, the token, the purpose and the stored row stay; `version` changes only when the tools or their hints did. A connector whose refresh fails, or whose upstream offers no usable tool, keeps its server. Resyncs run one at a time.

A resync makes five admin requests per connector and spaces them by `resyncIntervalMs` (default 1200, 50 a minute, half of the gateway's limit of 100 a minute, which locks the admin account for 15 minutes when exceeded; 0 turns pacing off). When the gateway answers 429, `resyncAll` stops there without retrying: that connector and the ones after it keep their servers and are reported as not resynced, and a single `resync` fails with `ConnectorRateLimited`.

The gateway's admin client gains `refreshGateway` and `setServerTools`, its tool type an optional `gatewayId`, its error type an optional `status`, and `ConnectorMessages` the keys `resyncDescription`, `resyncNameOption`, `resyncedTitle`, `resyncedAllTitle`, `resyncedFooter`, `resyncChanges`, `resyncUnchanged`, `resyncFailed`, `resyncNotAttempted` and the gateway's refresh-failure message. The `Connectors` service type gains `resync` and `resyncAll`; this breaks a host that implements `Connectors` itself, which needs both methods.

`mcpConnectors` resyncs every stored connector in its preflight, after loading them, at that pace. A failure is logged and the connector keeps the server it has. The `listFooter` text mentions `resync`.
