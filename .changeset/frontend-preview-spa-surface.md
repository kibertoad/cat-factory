---
'@cat-factory/app': minor
---

Browsable frontend preview — SPA surface (slice 5d of the frontend-preview + in-context
UI-testing initiative, docs/initiatives/frontend-preview-ui-testing.md).

The frontend-frame inspector now surfaces the live browsable preview: when the frame's
`previewEnabled` toggle is on (local/node only), a control shows the preview's status, a
clickable "Open preview" URL once it is serving, and start / stop buttons. A new
`usePreviewStore` drives the three preview endpoints (`GET|POST|DELETE
/workspaces/:ws/frames/:frameId/preview`), self-polling while the preview is `starting` so
the URL appears the moment it comes up. All copy is translated across every locale.
