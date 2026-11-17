---
type: Fixed
packages: [core]
---
`readAttachmentText` leaves the caller's bytes as they were: reading a PDF emptied the array, so the next piece read from the same bytes failed as `unreadable` or with a raw `TypeError`. Anything that goes wrong inside now rejects with an `AttachmentTextError`.

On a questionnaire card that more than one person may answer, a form submit writes only the fields that person changed from what they wrote before: a second owner sending only a note no longer erases the text the first wrote.

`readAttachmentText` and `read_attachment` never end a piece between the halves of a surrogate pair, so a piece no longer carries half an emoji; `offset`, `limit` and `total` are documented as UTF-16 units.

A PDF is parsed in a worker thread, so a large or crafted file no longer holds every channel's event loop. `readAttachmentText` refuses a PDF over 25 MiB with the new code `tooLarge`, reads at most 2,000 pages and 5,000,000 characters (leading the text with `[PDF, <n> pages; text of the first <m> only]`), and refuses a parse that takes longer than 30 seconds as `unreadable`.
