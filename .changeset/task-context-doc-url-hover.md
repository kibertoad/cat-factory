---
'@cat-factory/app': patch
---

Show the full URL of a task's attached context document on hover. In
`TaskContextDocs.vue` each linked document row now carries a native `title`
tooltip (`:title="doc.url"`, the app's established `title`-based tooltip pattern —
there is no `UTooltip`), so hovering a document reveals its canonical URL. Clicking
continues to open that URL in a new tab (`target="_blank"`).
