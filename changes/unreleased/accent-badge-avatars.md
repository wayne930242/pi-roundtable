---
type: Changed
packages: [web]
---
Every agent picture in the app is one accent badge: the figure stands free on a soft disc of the agent's accent, ringed in it, in the chat list, the pins, the side list, a room's header, the messages and everywhere else. The accent is lifted to 3:1 on the page, so a dark palette such as sable stays visible at night.

The Camelot look no longer draws the gold disc or the heraldic shield around a figure on the page; `useCharacterStyle()` loses `frame` and `frameOf` is gone. `RoomPicture` and `CharacterStack` lose `bare`, and `PageCharacter` no longer takes `bare`; `Character` gains `badge`.
