---
'@cat-factory/app': minor
---

Add account-tier prompt-fragment management to the unified **Account settings** panel.
Account-level fragments (hand-authored, document-backed living fragments from
Confluence/Notion/GitHub, and linked guideline repos) are now configurable for both personal and
org accounts, as a new "Context fragments" tab alongside the existing team/access tab (members,
roles, invitations, email sender, account API keys). The panel is reachable from the SideBar, the
account dropdown and the command bar. The fragment-library UI was made scope-aware (the store is
now an owner-keyed factory plus the active-board singleton) and the manager extracted into a
reusable `FragmentLibraryManager` shared by the board modal and the account panel. The backend
already served the account scope (`/accounts/:accountId/...`); this wires up the missing frontend.
Workspace settings → "Service best practices" now cross-links to both libraries (the account link
deep-links to the fragments tab).
