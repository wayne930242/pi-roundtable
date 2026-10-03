# Changelog

All notable changes to this project will be documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.7.4] - 2026-10-03

- Add `cardPresentation.result` for the card draw result text and `mapLimits` for longer relationship-map text.

## [0.7.3] - 2026-10-03

- Add `DrawingOptions.cardPresentation` for trusted operator card headings and reversal suffixes.

## [0.7.2] - 2026-10-02

First release published by the lockstep workflow; no changes to the package.
The `v0.7.1` tag published nothing.

## [0.7.0] - 2026-10-02

Prepared for the first npm publication.
The earlier `0.1.0` was local-only and was never published on npm.

### Changed

- Move into the pi-roundtable workspace with preserved Git history and lockstep version `0.7.0`.
  The shared `publish.yml` releases the core and all packages from one `v*` tag.
- The tools attach each picture to the agent's own reply with `turn.attachFile` instead of posting it as a separate message from the bot, so on Discord the picture arrives under the agent's name and avatar, after its text.
  This needs pi-roundtable 0.7.0 or newer; the peer dependency is now `>=0.7.0 <0.8.0`.
- A picture over the 10 MiB file limit of `REPLY_FILE_LIMITS` is refused with advice to ask for a smaller one.
  A turn that already holds the most files, or a surface that cannot carry files, fails the call with the host's message instead of dropping the picture.
- The tool results now say the picture is attached to the reply, not posted to the channel.
- Ship `@types/d3-force` as a dependency, since consuming hosts compile the published TypeScript source and need its declarations.

### Added

- `drawing(options)`: a pi-roundtable plugin whose tools draw images locally with node-canvas and post them to the channel of the turn as files.
- `relationship_map`: hand-drawn relationship maps, Rough.js on canvas laid out with d3-force.
- `magic_circle_generate`, `sigil_generate` and `sacred_geometry_generate`: magic circles, sigils, and sacred geometry. The Sri Yantra is a simplified figure, not the canonical nine-triangle construction.
- `draw_cards`: card draws and spreads from the operator's own decks, read from `deckDir` (one subdirectory with a `deck.json` for each deck). The package ships no card faces.
- The options `deckDir`, `random` (a seedable random source) and `minTier`.
- Noto Sans TC Bold under the SIL Open Font License, with its license, for the labels.
