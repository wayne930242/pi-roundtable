---
type: Added
packages: [core, web]
---
The chat home's knights move by part. A pin and a room row turn the head and sweep the held item with what the agent does: a glance now and then at rest, a ponder while thinking, a nod with the item's sweep while working, a cocked head and a raised item while a card waits, a nod and a flourish when a turn is done, a shake and a dropped item on an error, and a dozing head when it is sleepy; a new message perks the head up and hops the item. Rows at rest stay still inside and only breathe, a group's members each move their parts with the group's state, and reduced motion stops all of it.

The accent badge's disc and ring stay still now: only the figure breathes, pops and squashes on them. A figure no longer sways as a whole while its agent works, and a pin you hold to move is no longer squashed.

`pi-roundtable/characters` groups the head's parts (`head`, `hat`, `eyes-brows`, `mouth`, `fx`, `acc`) in one `<g class="hd" data-part="headset">`, and the hair behind the head carries class `hd` too, so a stylesheet can turn the head as one piece; the pixels of a figure do not change. `PIVOTS.neck` (`50px 76px`) is the pivot to turn it about, and `PIVOTS` is exported.

The pins in the phone home's dock, with no room open, are drawn at 80 px as designed (they were 56 px by mistake), and the dock gives each one the room.
