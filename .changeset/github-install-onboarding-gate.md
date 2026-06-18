---
'@cat-factory/app': minor
---

Add a post-login GitHub onboarding gate. When the GitHub integration is enabled
but the workspace has no App installation, the board is withheld behind a
full-screen prompt to install the cat-factory GitHub App (account-level install
via `github.com/apps/<slug>/installations/new` — the user grants all or a subset
of repos), reusing the existing `GitHubConnect` discover-and-link surface. The
page now probes the integration before mounting the board so an unconnected user
can't slip past, with a "Sign out" escape hatch to switch accounts. Previously an
unconnected user landed silently on a board they couldn't act on.
