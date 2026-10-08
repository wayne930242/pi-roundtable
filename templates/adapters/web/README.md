# __PROJECT__

A web chat agent server built on [pi-roundtable](https://www.npmjs.com/package/pi-roundtable) and [pi-roundtable-webchat](https://www.npmjs.com/package/pi-roundtable-webchat).
People your OpenID Connect provider signs in chat with the assistant in private conversations; there is no Discord.

1. Install: `bun install`, then copy `.env.example` to `.env` and fill it in.
2. Check: `bunx roundtable doctor` says what is still missing and how to fix it.
3. Run: `bunx roundtable start`, behind a reverse proxy that serves it over HTTPS.

The chat is under `/chat`: a web page gets a one-time ticket from `POST /chat/tickets` with the person's token, and opens `/chat/socket` with it.
The protocol is in `node_modules/pi-roundtable-webchat/README.md`.
Core `access` in `roundtable.config.ts` decides admission; token roles are prefixed with `web:role:` there.
New admitted users get principals, and linked Discord/web identities share private memory and quotas.
Link identities with `bunx roundtable principal link <principal> <identity>`; use `principal list` to inspect them.

The private inbox is `GET /chat/notices`, with `POST /chat/notices/<id>/read` to acknowledge an entry.
Online connections also receive additive `notice` frames.
Schedules and delegated reports can answer in their creator's private conversation; enable their tools in the persona selection only where intended and allowed by tier.

`roundtable.config.ts` holds the settings and lists the plugins; `plugins/` holds yours, and `persona/assistant.md` is the assistant's prompt.
Add another plugin with `bunx roundtable add plugin <name>`, and test it with `bun test`.
The plugin guide is in `node_modules/pi-roundtable/docs/plugins.md` and on the package's page.
