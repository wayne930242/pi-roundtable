---
type: Added
packages: [web]
---
An SVG that an agent attaches, or that a review block names as `image: file:<id>`, now shows inline in the web app, including its CSS and SMIL animation. It is served as `image/svg+xml` under a sandbox with no script, and opening its address directly downloads it instead of showing it as a page.
