---
'@cat-factory/app': minor
---

Surface an initiative's attached context documents and tracker issues in its inspector.

The create-initiative modal stages the same attachments the add-task modal does and links them
to the initiative block, and the whole planning pipeline reads them — but the inspector only
rendered those sections for a task, so an initiative's attachments became invisible the moment
the modal closed. The two context panels now gate on task-or-initiative, which also makes them
attachable after create (a re-run of planning picks up the addition).
