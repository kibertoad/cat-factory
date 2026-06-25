---
'@cat-factory/app': minor
---

Creating a task from a GitHub/Jira issue now surfaces the issue's description.
Previously only the title was prefilled and the issue body reached agents solely
via the context link, so the add-task form's description was empty. The form now
shows each linked issue's description in a read-only field above the editable one
(relabelled "Additional notes" when an issue is linked) and folds that body into
the new task's saved description, so the original description is visibly included
and the user can add notes on top. A search-hit issue's body is fetched (imported)
when the form opens so it can be previewed.
