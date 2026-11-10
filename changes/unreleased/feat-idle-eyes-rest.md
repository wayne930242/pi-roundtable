---
type: Changed
packages: [core, web]
---
On the chat home an idle agent rests with its eyes closed instead of blinking, so a list of idle figures no longer blinks all at the same moment. The kit adds a `resting` expression (a calm closed-eyed face; `STATE_EXPRESSION` is unchanged), `characters.css` never blinks it, and every other figure's blink is now offset by its `--phase`, so neighbours blink at different moments. The chat home's per-figure phase has a finer step, so two rooms rarely share one.
