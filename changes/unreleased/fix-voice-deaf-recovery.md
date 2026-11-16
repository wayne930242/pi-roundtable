---
type: Fixed
packages: [core]
---
The line a turn is given about forms, option buttons and checklists now speaks only of display blocks written in a reply, and says that a tool that asks the user, such as `ask_user`, works as its description says. Since 0.40 it read "This chat cannot show forms, option buttons or checklists. Ask in plain text.", which could keep a model from `ask_user` on Discord, where that tool posts a card with buttons.
