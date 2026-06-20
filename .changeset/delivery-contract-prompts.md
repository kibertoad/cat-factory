---
'@cat-factory/agents': minor
---

Fix the container coding-agent role prompts that told the agent to push and manage
the pull request itself — work it has no credentials for and was never meant to do.

The `build`, runnable-tests (`playwright`) and docs (`business-documenter`) gates each
instructed the agent to "open or update the pull request, push the fix, and wait for
CI". Inside the run container the agent has no push token (version control is the
platform's job), so a capable model would try `git push`, hit an auth wall, and then
burn the entire run probing env vars, decoding tokens and poking at git remotes
instead of doing the work (shipping zero changes and failing with "no file changes");
weaker models just gave up.

The three gates now share one `PLATFORM_DELIVERY_CONTRACT` (in `ci-gate.ts`) that makes
the boundary explicit: the agent commits its OWN work (it alone knows which files are
part of the solution vs scratch scripts/artifacts), validates locally, and stops; the
platform pushes, opens the PR and drives CI (dispatching a CI-fixer on failure). It is
told not to push, not to use `gh`/the GitHub API, and not to chase credentials, and to
bound its effort rather than spin. The `build` prompt is bumped to `build@v2`.

BREAKING: the `CI_RETRY_SANITY_CHECK` export is replaced by `PLATFORM_DELIVERY_CONTRACT`.
