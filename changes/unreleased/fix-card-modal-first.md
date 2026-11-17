---
type: Fixed
packages: [core]
---
Pressing "Write answer…", "Other…" or a questionnaire's "Write answers / note…" on a Discord card shows its form at once again: since 0.50.2 the press first read the thread's parent and who may answer, and when either took longer than Discord's three seconds the presser saw "This interaction failed" and nothing was logged. Nothing is read before a form is shown now; the thread comes from when the card was posted, and whoever submits the form is checked then: someone the card is not for may open it, but their answer is refused and changes nothing. Approve, Decline, Cancel and a menu pick are acknowledged before anything is read, and each press logs a debug line (`card press`) with the card, the control and the milliseconds to its first response, never what was answered.
