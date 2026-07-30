---
'@cat-factory/executor-harness': minor
'@cat-factory/local-server': minor
'@cat-factory/node-server': minor
'@cat-factory/orchestration': minor
'@cat-factory/agents': minor
'@cat-factory/kernel': minor
---

Record an inline harness-CLI step's model calls PER CALL and LIVE, instead of one lumped row at exit.

A local-mode document run reported **0 model calls for eight minutes** and then, when it was killed,
**one row of zero tokens** beside a failure message stating it had burned 896.7k. Both readings came
from the same cause: an inline step served by a harness CLI is not one model call. `doc-researcher`
on a host `claude` login runs a whole tool loop — a measured run made 16 calls over 8 minutes —
behind ONE `doGenerate`, and the instrumentation middleware wrapped around that boundary can only
ever see the boundary.

Three consequences, each a different way of being wrong about the same run:

- **One row for sixteen calls.** `message_count` 2 and `tool_count` 0 on a row whose loop used tools
  throughout, `total_ms` 497316 for "one call", and the fifteen intermediate turns' bodies nowhere.
  The container inline transport dropped its per-call metrics for the same reason: nothing on
  `InlineCliResult` could carry them.
- **Nothing at all until the subprocess exits.** `wrapGenerate` is a post-hoc hook with no
  `wrapStream` sibling, and the spawn settles only in `child.on('close')`. So the run was dark for
  its whole duration — precisely when someone is watching it.
- **Zeros whenever it was killed.** The middleware's error path has no usage to attach (a rejection
  carries none), so the row read `total_tokens 0`. What the run spent survived only inside the free
  text of `error_message`, through a deliberately lossy formatter — `896.7k` is not recoverable as an
  integer even in principle.

**The model now files its own calls, and the middleware stands down.** `CliInlineLanguageModel` takes
the facade's `InlineLlmCallRecorder` and records each call the CLI reports the moment it arrives, then
declares `reportsOwnLlmCalls` so `InstrumentedModelProvider` returns it unwrapped — two producers for
one call would double every token in the step's rollup, and of the two the middleware's is the less
truthful. The model is ASKED rather than a facade told, because the instrumentation is composed
OUTSIDE the wrap that substitutes the model (it has to be, or it sees nothing that wrap serves) and
cannot know what the inner wrap returned.

**The per-call fold is imported, not re-implemented.** Claude Code emits one envelope per content
BLOCK, each repeating that call's usage, so folding by `message.id` first is the difference between 31
calls and 117 — a measured 1.47M tokens inflated to 5.53M. The container harness had already solved
that, along with the prompt-transcript reconstruction and the routing of subagent turns off the
parent's chain; local carried a lesser copy of only the usage half, which is exactly why the two
paths disagreed about how many calls a step had made. `@cat-factory/executor-harness` now exports
that fold as the `./claude-stream` subpath and local drives it, so there is ONE implementation.

Also: the tag-then-scope attribution precedence is now one shared `resolveInlineAttribution`, since
two producers apply it; `InlineLlmCall` carries an optional `turnIndex`, real for a harness-CLI call
and absent for a plain `generateText`; and `ModelProviderResolverWrapDeps.recordInlineCall` is
required-but-nullable, so a facade that FORGOT it fails at typecheck rather than shipping a
deployment that silently reports no model activity.

Degradations are stated rather than papered over. A CLI that narrates nothing (`codex exec`), or a
build that narrates turns without per-turn usage, reports no call carrying tokens — the model then
files the single aggregate row the SDK boundary knows, carrying the terminal cumulative total, which
mirrors the harness's own fallback. A killed step still gets one `ok: false` row at the ordinal after
its last completed call, with zero tokens, which is now TRUE of it: it stands for the interrupted
call, and everything the run really spent is already on record.

**Deliberately still open:** the spend LEDGER. `token_usage` is written from the agent result on the
success path only, so a failed step writes no ledger row on either transport and the budget rollups
stay blind to what it burned. Closing that needs the failure-path recording seam in orchestration,
covering the container path in the same change — not a fourth pass over the inline provider.

`@cat-factory/executor-harness` now emits declarations (`declaration: true`), because the new subpath
is a `dist` import rather than the compile-only source `./embed` is.
