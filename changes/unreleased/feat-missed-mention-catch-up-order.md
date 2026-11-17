---
type: Changed
packages: [core]
---
The Discord surface hands a channel's messages to routing in the order they arrived, even when one takes longer to read, such as a reply whose referenced message is fetched or, with `discord.catchUp`, the record written before it is delivered; a slow read holds up the channel's later messages until it is done. A message that cannot be read is logged and skipped as before.
