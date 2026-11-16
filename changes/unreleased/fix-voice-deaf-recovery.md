---
type: Fixed
packages: [core]
---
Discord voice: a session no longer stays in a channel hearing nothing. After the voice library resumed a dropped voice socket, Discord's audio could stop arriving while the connection said it was ready, and the session heard nobody until it was left. A session now checks that audio arrives, from a speaker Discord has named to it, in two cases: within 2 seconds of Discord saying that someone in the channel is speaking (unless audio was heard in the 2 seconds before), and within 5 seconds of such a resume in a channel that was heard in the two minutes before. When none arrives, the voice connection is set up again, which nobody in the channel notices. When a speaker is still not heard 10 seconds later, the bot leaves the channel and joins it again, and the session keeps its members, its listeners and what it was hearing. A speaker who is not heard after that ends the session with `connection_lost`. Each step is a warning in the log. Silence alone never makes the bot leave the channel or ends the session, and neither does a bot that a moderator deafened in the server.

Discord voice: a session reads who is in its channel again when the bot's gateway connection to Discord is resumed or made again, not only when its voice connection came back, so `members()` stays right after Discord sent the guild's voice states anew.

Discord voice: a rejoin that throws as a live voice connection drops is logged and asked for again every 3 seconds, as a later one already was, and is no longer thrown into the voice library.

The line a turn is given about forms, option buttons and checklists now speaks only of display blocks written in a reply, and says that a tool that asks the user, such as `ask_user`, works as its description says. Since 0.40 it read "This chat cannot show forms, option buttons or checklists. Ask in plain text.", which could keep a model from `ask_user` on Discord, where that tool posts a card with buttons.
