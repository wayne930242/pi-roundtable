---
type: Added
packages: [core]
---
`PlaceProvider`, the contract for where an agent or group is spoken to on a chat surface, with `PlaceRef`, `PlacePost`, `PlaceSpec`, `PlaceCheck`, `PlaceAuthor`, `PlaceKind`, `ToolArgument` and `PlacePort`. A plugin contributes providers with the new `places` part, one per surface, and reads them through `context.places` once every plugin is set up (`of(surface or key)`, `stored()`, `all()`). Two providers for one surface, or one for a surface no plugin registers, stop the boot with a `PluginError` naming the plugins.

A surface that declares `agentRooms: true` and has no provider gets a derived one from the host, so the web app and any plugin written before this change keep working untouched. The Discord plugin contributes its own, over the agent guild's channels and threads, when `discord.guild` is set; its `check` tells a channel of another server (`foreign`) from a deleted one (`gone`). The agent team does not use providers yet.

`placeProviderContract` in `pi-roundtable/testing` runs the provider contract against any provider, with `checkPlaceProviderContract` for the failures as data, and `PlaceContractSubject`, `PlaceContractFailure` and `PlaceSeen` for what it takes and returns.
