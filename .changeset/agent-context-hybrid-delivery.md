---
"@cat-factory/kernel": minor
"@cat-factory/agents": minor
"@cat-factory/integrations": minor
"@cat-factory/orchestration": minor
"@cat-factory/server": minor
"@cat-factory/worker": minor
"@cat-factory/node-server": minor
"@cat-factory/executor-harness": minor
---

Hybrid linked-context delivery to agents, and deterministic reference resolution.

Linked documents and tracker issues now reach a container agent as a cheap in-prompt
summary index plus their full bodies materialised into a `.cat-context/` directory in the
checkout (kept out of the agent's commits via a local git exclude), so the agent reads only
what it needs on demand — replacing the previous 280-char document excerpt. Inline (no-
checkout) agent kinds instead get the budgeted full body injected into the prompt.

The engine also resolves references named explicitly in a block's description or its
incorporated requirements (Jira keys like `PROJ-123`, fully-qualified GitHub `owner/repo#123`,
and URLs) against the already-imported corpus, folding those high-confidence items into the
context set. Each reference is resolved by a **point lookup** (a keyed `get`, or a new
`getByUrl` repository method) rather than scanning the whole workspace corpus per step. Bare
`#123` refs are intentionally not resolved: a workspace can hold many repos, so a bare number
is ambiguous — name the issue as `owner/repo#123` (or by URL) to pull it in. There is no
speculative relationship graph and no live fetching: everything is prepared backend-side,
which is required because the container harness cannot reach Jira/Confluence/GitHub itself.

Documents gain a `content_hash` column (D1 + Drizzle) so a re-import whose body AND title/url
are unchanged is a no-op, preserving the existing projection and block link; a renamed/moved
page still re-projects.

Breaking (pre-1.0): `AgentRunContext.block.contextDocs` items now carry `summary` + `body`,
`contextTasks` items carry `summary`, and `DocumentRecord` carries `contentHash`. The
`DocumentRepository`/`TaskRepository` ports gain a `getByUrl` method (implemented on both the
D1 and Drizzle stores). The executor-harness image gains an optional `contextFiles` job field;
bump the runner image tag.
