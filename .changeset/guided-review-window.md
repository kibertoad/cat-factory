---
'@cat-factory/app': minor
---

The SPA gains the guided PR review window. It opens from the sidebar and command palette ("Explore a pull request"), where a linked repository and one of its pull requests are picked, or from a `review` task's inspector on the PR that task targets. The window shows the PR's overview (summary, intent, meaningful changes, consequences, risks, areas worth reviewing) with suggested questions as chips, beside tabbed exploration threads. Each thread waits on its own answer only, so other tabs stay usable, and each can ask for review comment drafts, which are listed read-only with every refused proposal and its reason. A failed overview or answer shows its translated reason, with the raw cause behind a disclosure, and the overview flags a pull request that has moved past the reviewed commit. All copy is translated in every locale.
