# Changelog

All notable changes to this project will be documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.1.0] - 2026-10-02

### Added

- `drawing(options)`: a pi-roundtable plugin whose tools draw images locally with node-canvas and post them to the channel of the turn as files.
- `relationship_map`: hand-drawn relationship maps, Rough.js on canvas laid out with d3-force.
- `magic_circle_generate`, `sigil_generate` and `sacred_geometry_generate`: magic circles, sigils, and sacred geometry. The Sri Yantra is a simplified figure, not the canonical nine-triangle construction.
- `draw_cards`: card draws and spreads from the operator's own decks, read from `deckDir` (one subdirectory with a `deck.json` for each deck). The package ships no card faces.
- The options `deckDir`, `random` (a seedable random source) and `minTier`.
- Noto Sans TC Bold under the SIL Open Font License, with its license, for the labels.
