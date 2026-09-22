---
'@cat-factory/app': minor
---

Themes as Nuxt UI theme editor documents, with a theme switch. The Appearance picker gains a
Theme group with two built-ins: Cat Factory (indigo on slate, the default) and the editor's own
Mono preset (black on a pure grey neutral, generous radius, Geist). A theme is the sparse document
the editor (https://ui.nuxt.com/theme) edits and shares, applied at runtime: aliases land on
`app.config` `ui.colors`, default variants on `ui.<component>`, tokens / radius / fonts on one
injected stylesheet. The pre-JS loading shell wears the active theme from a per-theme, per-mode
cache of its computed colours. The built-in faces (Geist, Geist Mono) are self-hosted through
`@nuxt/fonts`. Importing a user's own theme is the next change.
