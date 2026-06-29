---
'@cat-factory/app': patch
---

Turn the "add a service from a GitHub repo" picker into a typeahead combobox:
type to search repositories with a debounced, case-insensitive substring match
over `owner/name` (matches any part of either). Replaces the separate filter
input + dropdown. The min-length search gate only applies to large lists — a
small set of repos (25 or fewer) stays fully browseable up-front without typing,
and the combobox gets a clear-selection control.
