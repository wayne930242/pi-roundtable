---
type: Fixed
packages: [core]
---
A card answered after its turn stopped waiting now starts its late turn with the card's thread (`thread.parentId` and `parentKind`), as the live message there carries it, so a consumer that routes by thread, such as a forum post, handles the late answer the same way as a live one.
