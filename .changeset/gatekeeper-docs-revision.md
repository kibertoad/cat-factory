---
---

Docs only: revise the Gatekeeper documentation. The three READMEs (`sdk/gatekeeper`,
`sdk/gatekeeper-worker`, `deploy/gatekeeper`) are restructured around what each piece is, its
purpose, usage, configuration and customization, with a shared orientation table and cross-links;
`docs/glossary.md` gains the Gatekeeper naming map; the initiative tracker registers the two gaps
the sweep could not close. The one behaviour the sweep found the docs describing rather than
reporting is fixed in its own changeset (`/health` over the whole configuration); nothing else in
a versioned package changes.
