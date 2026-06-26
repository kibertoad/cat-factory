---
'@cat-factory/app': minor
---

Add an **Account settings** page with account-tier prompt-fragment management. Account-level
fragments (hand-authored, document-backed living fragments from Confluence/Notion/GitHub, and
linked guideline repos) are now configurable for both personal and org accounts, reachable from
the account dropdown and the command bar. The fragment-library UI was made scope-aware (the store
is now an owner-keyed factory plus the active-board singleton) and the manager extracted into a
reusable `FragmentLibraryManager` shared by the board modal and the account settings page. The
backend already served the account scope (`/accounts/:accountId/...`); this wires up the missing
frontend. Workspace settings → "Service best practices" now cross-links to both libraries.
