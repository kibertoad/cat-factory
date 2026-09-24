---
---

Palette guard: a `#NNN` glued to a word char or `/` is an issue or URL reference, not a short-hex
colour, so the colour-literal rule no longer misfires on `acme/web#123` (issue #2261).
