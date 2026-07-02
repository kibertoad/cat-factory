---
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/app': minor
---

Enable the prompt-fragment library by default and streamline linking GitHub-backed fragments.

- The prompt-fragment library (ADR 0006) is now **on by default** in both runtimes; opt out
  with `PROMPT_LIBRARY_ENABLED=false`. Previously it was off unless `PROMPT_LIBRARY_ENABLED=true`
  was set, so linking a GitHub document as a fragment failed with "Prompt-fragment library is
  not configured" on a stock deployment.
- The fragment-library manager now reuses the same GitHub affordances as the other repo
  windows: a **server-side repo search** (new `GitHubRepoSearchSelect`) plus the
  `RepoTreeBrowser` to browse to a **file** (document-backed fragments) or **directory**
  (repo sources), instead of hand-typing `owner`/`repo`/`path`/`ref`. Manual entry remains as
  a fallback when the GitHub App isn't connected.
- When the library is explicitly disabled, the manager now shows a clear notice instead of
  offering forms that fail with a raw 503.
