---
'@cat-factory/app': patch
---

The pipeline builder's binary output picker no longer drops a step's formats, generation options and candidate comparison when another of its settings is edited. The draft store keeps every field of the selection and drops only empty values (`undefined`, `null`, a blank string or an empty list), and the save applies the same rule to a selection loaded for edit.
