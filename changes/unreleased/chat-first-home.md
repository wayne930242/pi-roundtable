---
type: Added
packages: [web]
---
The web console can open on a chat list: set `appearance.home: "chats"` and the app opens on the pinned rooms as big figures, folder chips that filter one list of the other rooms by latest activity, and one row for the hidden and archived rooms. The tab bar and the rail are gone; a grid button opens every other pane, a back bar leads home, and from 1024 px the home is a 380 px column beside the open room. The default `"rooms"` keeps the arranged room list.

Rooms can be hidden (`PUT api/rooms/<key>/hidden`, owner only, shared by every owner): a hidden room keeps answering, running schedules and pushing and leaves only the home and the switcher. `GET api/rooms` and the layout answers carry `hidden`; the migration `web-room-hidden` adds its table.
