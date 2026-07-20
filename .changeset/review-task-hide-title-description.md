---
'@cat-factory/app': patch
---

Hide the Title and Description fields on the Add-task form for review tasks. The target
pull request is the subject (the title is derived from the PR reference) and any notes
belong in the dedicated "Review focus" field, so the generic Title/Description inputs
were redundant. A follow-up to #1250, which made the review title optional but never
actually removed the fields from the form.
