---
type: Changed
packages: [web]
---
Every Markdown view draws a fenced code block with one shared element, `CodeBlock`, whose button copies the code: a message and a host room as before, and now a skill document too, which had its own block without the button. On a screen with a mouse the button shows faintly until the block is pointed at, instead of not at all. The message menu's "Select text" sheet shows the text in a read-only field, which keeps its own selection, so scrolling a long message while selecting no longer loses what was picked; its Close and Copy all buttons stay in view below the field.
