# __PROJECT__

A Discord agent server built on [pi-roundtable](https://www.npmjs.com/package/pi-roundtable).

1. Install: `bun install`, then copy `.env.example` to `.env` and fill it in.
2. Check: `bunx roundtable doctor` says what is still missing and how to fix it.
3. Run: `bunx roundtable start`.

`roundtable.config.ts` holds the settings and lists the plugins; `plugins/` holds yours.
Add another with `bunx roundtable add plugin <name>`, and test it with `bun test`.
Add a Pi package from npm with `bunx roundtable add package <name>`; it installs the package and writes the plugin that loads it.
The plugin guide is in `node_modules/pi-roundtable/docs/plugins.md` and on the package's page.
