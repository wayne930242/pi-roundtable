# Changelog

All notable changes to this project will be documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- Main entry exports: `AgentSeed`, `ChannelClaim`, `Contribution`, `DefinedRoundtable`, `EventHandlers`, `HoldRule`, `InteractionContribution`, `Migration`, `NotLinkedError`, `PluginContext`, `PluginError`, `PromptSection`, `PromptTurn`, `Roundtable`, `RoundtableConfig`, `RoundtableOptions`, `RoundtablePlugin`, `Service`, `SessionTool`, `Speaker`, `Tier`, `ToolContribution`, `ToolRefusal`, `ToolSpec`, `ToolTurn`, `TurnEndEvent`, `TurnEvent`, `definePlugin`, `defineRoundtable`, `defineTool`.
- Testing entry exports: `RecordedEvent`, `TestPluginOptions`, `TestPluginResult`, `testPlugin`.
- The `roundtable` command: `init [dir]` creates a project from `templates/`, `doctor` checks Bun, `.env`, the configuration, PostgreSQL, Discord (token, guild, intents, entry-channel permissions), the model login, and the public URL and says how to fix each failure, `start` runs the checks that need no network and then the bot, and `add plugin <name>` renders `plugins/<name>.ts` and its test and lists the plugin in `roundtable.config.ts`.
- `@babel/parser` as a dependency, for the syntax-tree edit `add plugin` makes to `roundtable.config.ts`.
- `SessionTool.engine`: a compaction-phase tool names the `details.engine` its compactions record, so the compaction tiers tell its compactions from Pi's own. `defineRoundtable` refuses a compactor without one.
- The judge's yes-or-no question is `YesNoQuestion` (`type: "yesno"`), asked with `Judge.askYesNo`, next to `askChoice` and `askScore`.
- `docs/plugins.md`, the plugin guide: what a plugin is, each part with an example, the order things start and stop in, and every startup error with its fix. `examples/` holds one plugin and its test per part; a test fails when an example embedded in the guide differs from its file.
- The README's five-minute path: `init`, `.env`, `doctor`, `start`, a minimal plugin, the requirements, and the `locale` setting.
- `scripts/scan-public.ts` ships in the repository, and CI runs it against the checked-out tree before install, so a host address, Discord id, credential, or private name fails the build. The lockfile may name a registry dependency.

### Changed

- The compaction tiers name the compactor by its role: the engine is `extension` or `pi`, `CompactionTiers` takes the extension's engine as an argument, and its `wrapCompactor` replaces the wrapper named for one compactor.
- Time-zone wording derives from the configured zone in every catalog: English names the IANA id, Traditional Chinese the city, and the `at` and `time` errors of a schedule name the zone.

### Fixed

- `testPlugin`'s `contribution` includes the `agentSelection` a plugin adds; it was left out.
- A setup that throws a `NotLinkedError` reports its reason without a doubled period.
