---
'@cat-factory/server': patch
---

Workspace-RBAC security follow-ups (SEC-RBAC-0, SEC-RBAC-5):

- SEC-RBAC-0 (High): the account-tier document-fragment routes now re-authorize the
  body/query-supplied `viaWorkspaceId` before fetching through that workspace's stored
  document-source credentials — it must belong to the addressed account AND be accessible to the
  caller, else 404. Closes a cross-tenant confused-deputy that let an account member drive another
  workspace's stored Confluence/Notion/GitHub secret as a fetch oracle.
- SEC-RBAC-5 (Low): the auth gate returns a 404 (not an opaque 500) when the `:workspaceId` path
  segment is malformed percent-encoding.
