---
type: Added
packages: [web]
---
A person can design their own knight on the profile page, with the creator the knights use ("Your knight": Design my knight, Change look, Remove). The chat home's own picture, the person's own messages (beside the first of each group, at the right), their notes, the "seen by" faces and the profile's account head draw it, and so does everyone else past the gate. A person without a knight keeps their account picture, then their initials. The profile shows the card on hosts that serve the rooms pane.

New routes: `PUT` and `DELETE api/profile/character`, and `GET api/people/<principal>/character` (another person's only past the gate, like their picture). `GET api/profile` and the socket's `ready` frame carry the person's own knight as `character`. The knights are kept in a new table, `web_person_characters`.
