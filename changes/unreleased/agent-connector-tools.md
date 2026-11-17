---
type: Added
packages: [mcp, web]
---
Agents get `connector_list`, `connector_add` and `connector_remove` for the owner's MCP connectors, and none takes or shows a connector's URL. `connector_list` gives each connector's name, host, tool count and purpose. `connector_remove` is held under a new rule, `connector`, which yolo mode never approves; its card names the connector and its host only. `connector_add` takes a name and purpose only. With pi-roundtable-web it returns a one-time link (an hour, single use) to the connectors page's add form, filled in, where the owner pastes the URL; the asking conversation then gets a follow-up with the outcome. On Discord it points the owner to `/<root> connector add`.

The web console stores those add requests (never a URL) in `web_connector_add_requests`, serves them under `api/connectors/requests/<id>`, and opens the add form at `#/connectors?add=<id>`.
