# pi-roundtable-drawing

A plugin for [pi-roundtable](https://github.com/wayne930242/pi-roundtable), the Discord agent server, that gives agents tools to draw images locally and post them in the channel:

- Relationship maps: characters and factions joined by typed relationships, hand-drawn.
- Magic circles, sigils, and sacred geometry.
- Card draws and spreads, from tarot or playing-card decks that you supply.

Everything is drawn on the host with [node-canvas](https://github.com/Automattic/node-canvas); there is no image service, API key, or network call.
Bun only, like pi-roundtable.
The package ships its TypeScript source, so there is no build step.
MIT licensed.

## What you need

- [Bun](https://bun.sh/docs/installation) 1.3 or newer.
- A running pi-roundtable host, version 0.7.0 or newer in the 0.7 line (`pi-roundtable` is a peer dependency, `>=0.7.0 <0.8.0`). Earlier versions cannot attach files to an agent's reply, which these tools rely on.
- The native [canvas](#the-native-canvas-dependency) package, which comes with this one.
- For `draw_cards`, a deck directory of your own; see [the deck directory](#the-deck-directory).

## Install

```sh
bun add pi-roundtable-drawing
```

canvas fetches its native binary in an install script.
Bun runs it without further setup, since canvas is on Bun's default list of trusted dependencies; if your project sets `trustedDependencies` itself, keep `canvas` in it.

### The native canvas dependency

[canvas](https://github.com/Automattic/node-canvas) is a native module, which draws with Cairo and Pango.
Its install script downloads a prebuilt binary where it has one: macOS (Intel and Apple silicon), Linux on x86-64 with glibc, and Windows on x86-64.
Anywhere else, such as Linux on ARM64 or Alpine, it compiles from source, which needs a compiler and the libraries below.

| System | Command |
| --- | --- |
| Ubuntu and Debian | `sudo apt-get install build-essential libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev` |
| Fedora | `sudo yum install gcc-c++ cairo-devel pango-devel libjpeg-turbo-devel giflib-devel` |
| macOS | `brew install pkg-config cairo pango libpng jpeg giflib librsvg pixman python-setuptools` |

On a prebuilt platform you need none of these.
If the module cannot load, the host fails when it imports the plugin, with the loader's own message; reinstall after the libraries are in place, with `bun install --force`.

## Configure

List the plugin in `roundtable.config.ts`.
It reads nothing from the environment and needs no database.

<!-- example: examples/roundtable.config.ts -->
```ts
import type { RoundtableConfig } from "pi-roundtable";
import { drawing } from "pi-roundtable-drawing";

// Credentials come from .env, which Bun loads on its own; nothing secret belongs in this file.
const env = (name: string): string => process.env[name] ?? "";

export default {
	name: "Roundtable",
	owner: { id: env("OWNER_ID"), name: env("OWNER_NAME") },
	discord: {
		token: env("DISCORD_TOKEN"),
		guild: env("DISCORD_GUILD_ID"),
		entryChannel: env("DISCORD_ENTRY_CHANNEL_ID"),
	},
	database: { url: env("DATABASE_URL") },
	dataDir: "./data",
	model: env("MODEL"),
	http: { publicUrl: env("PUBLIC_URL") },
	plugins: [
		// The deck directory is optional: without it the plugin has no draw_cards tool.
		drawing({ deckDir: "./decks" }),
	],
} satisfies RoundtableConfig;
```
<!-- /example -->

### `drawing(options)`

| Option | Type | Default | What it is |
| --- | --- | --- | --- |
| `deckDir` | `string` | none | A directory with one subdirectory for each deck; see [the deck directory](#the-deck-directory). Without it the plugin has no `draw_cards` tool. A directory that does not exist, holds no deck, or holds an invalid manifest stops the start with a message that names the deck and what to fix |
| `random` | `() => number` | `Math.random` | The random source of the map layouts and the card draws, returning a number from 0 up to, not including, 1. A seeded source makes a run reproducible: a new `seededRandom(seed)` given the same calls draws the same pictures. `seededRandom(seed)` is exported for that |
| `minTier` | `"owner" \| "admin" \| "member"` | `member` | The lowest tier that may use the tools. The operator's `toolTiers` setting still wins |
| `cardPresentation` | `CardPresentation` | package captions | Trusted operator-local headings, reversal suffixes and result text |
| `mapLimits` | `{ title?, text? }` | 80 and 60 | Longest relationship-map title, and node id, node label or edge label, in characters, for a host whose callers already draw longer text; each is a whole number of at least 1 (anything else stops the start), and the renderer's size limit still applies |
| `permissive` | `boolean` | `false` | Accept what a looser host's callers already send: a card exclusion that is not a card of the deck is ignored, spread positions may share a cell, and a relationship map may repeat or leave empty a node id and may draw an edge from a node to itself. By default each is refused with a message the model can correct |

The plugin is named `drawing`.
`cardPresentation.heading(draw, turn)` returns `{ title, subtitle }`; `draw` holds the selected `deck`, `count`, and optional `question`, and `turn` carries the host-bound speaker/channel.
`cardPresentation.reversedSuffix` replaces the default `" (reversed)"` on pictured reversed card names.
`cardPresentation.result({ deck, cards, positions })` replaces the text the model reads back after a draw; `{file}` stands for the attached file's name.
These hooks change only presentation, not card selection, model-visible arguments, or attachment limits.
They are trusted configuration callbacks, never guest-supplied code.

## The tools

Each tool draws one PNG and attaches it to the agent's reply with `turn.attachFile`.
The model reads a short text back (the file name, and for card draws the cards), and a request it can fix comes back as a refusal with a plain message, such as `An edge references the unknown node "Ghost". Add it to nodes or fix the edge.`
Nothing is attached for a refused call.

The tool does not send a message of its own: the host delivers the picture with the reply of the turn, after the agent's text, under the same name and avatar as the text.
On Discord each picture goes out as one file in its own message.

The host limits what one turn may attach (`REPLY_FILE_LIMITS`: 10 files, 10 MiB for a file, 50 MiB in all), and a chat surface may be stricter.
A picture over 10 MiB is refused with a message that suggests a smaller one, such as fewer cards or a smaller `size`.
A turn that already holds 10 files, or a surface that cannot carry files, fails the call with the host's message; the picture is never dropped silently.
Each tool call attaches one picture, so one reply can carry up to ten of them.

| Tool | What it draws | Arguments |
| --- | --- | --- |
| `relationship_map` | A hand-drawn map of characters and factions with typed relationships, sized to its content: a node grows to hold its name | `title` (up to 80 characters); `nodes` (1 to 40, each with a unique `id` of up to 60 characters, `type` of `pc`, `npc` or `faction`, and an optional `label` of up to 60); `edges` (up to 80, each between two different nodes, with `from` and `to` node ids, `type` of `romantic`, `entanglement`, `bond`, `faction` or `hostile`, and an optional `label` of up to 60) |
| `magic_circle_generate` | A pentagram, hexagram, or Tree of Life, with optional elemental symbols and text around the rim | `type` (`pentagram`, `hexagram`, `tree_of_life` or `custom`, which draws a pentagram); `style` (`traditional`, `modern`, `geometric`: the line weight); `elements` (up to four of `fire`, `air`, `water`, `earth`, placed north, east, south, west); `text` (up to 60 characters); `size` (`small`, `medium`, `large`: 512, 1024 or 2048 px); `background` |
| `sigil_generate` | A sigil from an intention, 512 px square | `intention` (up to 200 characters); `method` (`chaos`, `rose_cross`, `planetary` or `geometric`); `complexity` (`simple`, `elaborate`); `style` (`traditional`, `modern`); `background` |
| `sacred_geometry_generate` | The Flower of Life, Metatron's Cube, a simplified Sri Yantra, or the Vesica Piscis, 1024 px square, always scaled to fit the frame | `pattern` (`flower_of_life`, `metatron`, `sri_yantra`, `vesica_pisces`); `layers` (1 to 9, default 3); `rotation` (degrees); `colors` (up to 9 CSS colors, cycled per layer); `background` |
| `draw_cards` | A spread of cards drawn from a deck | See [card draws](#card-draws) |

`background` is `dark` (the default), `white`, or `transparent`.
The chaos, rose cross, and planetary sigils draw from the letters of the intention; an intention with no letters is refused, and the geometric method takes any text.

A relationship map and a card draw are random: a map's layout and hand-drawn wobble come from the `random` option, and a draw shuffles with it.
The magic circle, sigil, and sacred geometry tools draw the same picture for the same arguments.

What `layers` does depends on the pattern: the Flower of Life has that many rings of circles around the centre, the Vesica Piscis that many nested pairs of circles, and the Sri Yantra that many nested pairs of triangles.
Metatron's Cube has one fixed form that `layers` only switches: one layer is the inner seven circles, two or more the full thirteen, each joined to every other by a line.
The Sri Yantra is a simplified figure of interlocking upward and downward triangles around a point, in a circle; it is not the canonical nine-triangle construction.

### Card draws

`draw_cards` draws from a full, freshly shuffled deck on every call; there is no deck kept between draws.
It takes:

| Argument | What it is |
| --- | --- |
| `deck` | The id of one of your decks: the name of its directory |
| `count` | How many cards, from 1 to 100 and no more than the deck has left. The cards fill rows of up to 5, 5, or 7 |
| `group` | Draw only from the cards of this group, such as `major` in a tarot deck |
| `exclude` | Card ids to leave out; an id the deck does not list is refused |
| `allow_reversed` | Whether cards may come up reversed, which draws them upside down. The deck's `reversals` setting when omitted |
| `spread` | One `{ row, col, label }` for each card, to place them in a named spread (rows and columns from 0 to 10, no two cards in one place). Without it the cards fill rows in order |
| `question` | Shown under the deck's name on the picture |

The tool's description lists your decks by id and the `name` of each manifest, with the number of cards and their groups, so the model knows what it can draw from.
No deck name is built into the package.

## The deck directory

The package ships no card faces.
You point `deckDir` at your own directory, which holds one subdirectory for each deck.
The subdirectory's name is the deck's id (lowercase letters, digits, dashes, and underscores), and it holds a `deck.json` and the face images the manifest names:

```text
decks/
  my-tarot/
    deck.json
    faces/
      fool.jpg
      magician.jpg
  playing-cards/
    deck.json
```

A subdirectory without a `deck.json` is ignored.
Use only images that you may use: the package cannot tell you whether a deck's artwork is free to copy.
[`examples/decks`](examples/decks) holds two example manifests, with no faces and no artwork: a 54-card deck of playing cards and a 78-card tarot deck with the traditional names.
A card without a `file` is drawn as a plain tile with its name, so a deck works before you have any images.

### The manifest

```json
{
	"name": "My Tarot",
	"reversals": true,
	"aspect": 1.714,
	"cards": [
		{ "id": "fool", "name": "The Fool", "file": "faces/fool.jpg", "group": "major" },
		{ "id": "ace-of-cups", "name": "Ace of Cups", "file": "faces/cups-01.jpg", "group": "cups" },
		{ "id": "joker", "name": "Joker" }
	]
}
```

| Field | Required | What it is |
| --- | --- | --- |
| `name` | yes | The deck's name, shown on the picture and in the tool's description |
| `reversals` | no | Whether a draw may turn cards upside down unless the call says otherwise; default `true`. Set `false` for a deck that is read upright, or for playing cards |
| `aspect` | no | A card's height divided by its width, from 0.25 to 4. Without it the ratio of the first face drawn is used, and 1.5 when no drawn card has a face |
| `cards` | yes | At least one card |
| `cards[].id` | yes | What the model passes to `exclude` and reads back, unique within the deck |
| `cards[].name` | yes | What is written under the card and returned to the model |
| `cards[].file` | no | The face image, relative to the deck's directory: `.png`, `.jpg`, `.jpeg`, or `.gif`. It must exist and be a readable image whose height is between 0.25 and 4 times its width, and it may not lead outside the deck's directory, through a `..` segment, an absolute path, or a link |
| `cards[].group` | no | A group the model can draw from, such as a suit |

Any other field is refused, so a misspelled key does not pass silently.
The manifests, and every face they name, are read when the host starts: a bad one stops the start with a message such as `plugin drawing: deck my-tarot: card fool: file faces/fool.jpg does not exist in the deck directory.`

## Fonts and licenses

Labels are drawn in Noto Sans TC Bold, which covers Latin and Chinese, so names in either script render.
The font is under the SIL Open Font License 1.1; its license is [`fonts/OFL.txt`](fonts/OFL.txt) and ships with the package.
The package itself is MIT licensed.

## Testing a plugin that uses it

`testPlugin` from `pi-roundtable/testing` runs the plugin offline.
Pass a chat surface for the prefix of the channel the test uses (the default channel is `test:1`) that declares `supportsFiles: true`, since a surface that does not makes the call fail, and read the files from `harness.files`, each with the channel of the turn it was attached to:

```ts
import { testPlugin } from "pi-roundtable/testing";
import { drawing, seededRandom } from "pi-roundtable-drawing";

const harness = await testPlugin(drawing({ random: seededRandom(1) }), {
	surfaces: [
		{
			surface: "test",
			supportsFiles: true,
			start: async () => {},
			sendReply: async () => {},
		},
	],
});
await harness.runTool("sigil_generate", { intention: "home", method: "chaos" });
const { channel, file } = harness.files[0]; // "test:1", sigil.png
```

## Development and publishing

This package lives in `packages/drawing` in the pi-roundtable workspace.
Run these commands from the repository root:

```sh
bun install --frozen-lockfile
bun run --cwd packages/drawing typecheck
bun run --cwd packages/drawing lint
bun run --cwd packages/drawing test
```

The package shares the core's version and single `v*` release tag.
The shared `publish.yml` checks all workspaces and publishes each npm package separately with provenance.
