---
'@cat-factory/app': patch
---

Fix Slavic (pl/uk) pluralization and tidy the `en` catalog. Wire a CLDR one/few/many
`pluralRules` selector for `pl`/`uk` in `i18n.config.ts` — vue-i18n's built-in pluralizer
never selects the correct few/many form, so 3-form entries like `board.toolbar.decisionWord`
rendered the wrong word for counts like 2-4. Also add ARB-style `@key` translator-context
notes next to the genuinely ambiguous `en` keys (inert at runtime — never resolved via
`t()`), and fix `nav.modelConfiguration` casing to match the sentence-case of the other nav
labels.
