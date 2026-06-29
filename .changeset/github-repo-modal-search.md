---
'@cat-factory/app': patch
---

Turn the "add a service from a GitHub repo" picker into a typeahead combobox:
type to search repositories with a debounced, case-insensitive substring match
over `owner/name` (matches any part of either), kicking in once at least three
characters are entered. Replaces the separate filter input + dropdown.
