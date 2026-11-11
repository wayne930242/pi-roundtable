---
type: Fixed
packages: [mcp]
---
A connector is unknown to every other call from the moment its removal is asked, not only once its row is deleted: a resync that waits its turn (`resync`, or the connector's turn in `resyncAll`), a `describe`, or a second `remove` is refused with the unknown-connector message while the row is still being deleted. Before, a resync whose turn came in that time ran on the connector being removed and reported it resynced. A removal the database fails leaves the connector as it was.
