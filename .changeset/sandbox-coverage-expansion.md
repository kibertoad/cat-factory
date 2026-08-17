---
'@cat-factory/sandbox-fixtures': minor
'@cat-factory/orchestration': minor
'@cat-factory/contracts': minor
'@cat-factory/sandbox': minor
'@cat-factory/agents': minor
'@cat-factory/server': patch
'@cat-factory/app': minor
---

Widen the Sandbox: more agent kinds, rubrics that match the task, and a repo-scale review fixture.

Every cell now renders its task input through the SAME pure prompt builder its production caller
uses, instead of a hand-rolled approximation that dropped each prompt's output contract and scope
rules. `@cat-factory/agents` gains `composedSystemPromptFor`, the one place that decides
bespoke-vs-composed prompt assembly (container dispatch and the Sandbox both ride it), and the
Sandbox baseline text is now the promotable `shippedBasePromptFor` unit rather than
`PROMPT_VERSIONS[id].text`, which for an inline engine kind is the already-composed prompt.

The `task-estimator`'s JSON output contract is now the named `TRIAGE_JSON_CONTRACT` and an
`OVERRIDE_PRESERVED_FRAGMENTS` member, so a per-workspace override (or a promoted Sandbox
candidate) can no longer delete the shape `coerceTaskEstimate` parses. An unedited prompt is
byte-identical.

Four new rubrics (`architecture-review`, `bug-triage`, `estimation`, `answer-recommendation`); two
new testable kinds (`task-estimator`, `requirements-writer`) with their fixtures; and a repo-scale
multi-file code-review fixture delivered through `injectedContextFiles`.

Breaks internal shapes, per the pre-1.0 rule for everything the public API does not cover:

- `SandboxAgentKindMeta` / the `/sandbox/overview` response replace the single `bucket` field with
  `bucket` (production surface) plus `sandboxRun` and `unsupportedReason`. The last is a bounded
  reason CODE (`sandboxUnsupportedReasonSchema`), not prose: the backend refusal and the SPA's
  translated note are both derived from it. Stored fixtures, experiments and prompt candidates are
  unaffected.
- The builtin fixture library is now reconciled against the shipped catalog on every read rather
  than seeded once when a workspace has none, so a workspace that used the Sandbox before a release
  picks up that release's fixtures. A builtin row whose content has drifted from the catalog is
  refreshed in place; workspace-authored fixtures are never touched.
- `clarity-review` and `architect-companion` grade on new rubrics, so their dimension keys change.
  Grades recorded before this change carry the old keys and are no longer comparable with new ones;
  re-launch an experiment to re-grade it.
- A Sandbox prompt candidate cloned from the `requirements-review`, `clarity-review` or
  `requirements-writer` baseline before this change contains the directives half of its prompt.
  Re-clone it rather than promoting it, or promotion doubles those directives.
