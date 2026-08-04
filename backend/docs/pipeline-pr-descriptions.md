# Pipeline PR descriptions: the agent-authored reviewer briefing

The agent writes its reviewer briefing to `.cat-pr-description.md` (requested **only when
`opensPr`**, since an in-place fixer amends a PR whose description it doesn't own) and the harness
lifts it onto `openPullRequest` scrubbed, capped and git-excluded; absent means the dispatch-time
`prBody()` fallback, which marks itself agent-less. The sentinel name is kept in sync agents ⇄
harness, so changing it means an image bump. `MAX_PR_BODY_CHARS` (15k) plus the report's
`MAX_SECTION_CHARS` (50k) must stay under the host's 65,536 limit, or the verification report
silently stops publishing. **A RESUMED run must refresh the PR it already opened**
(`refreshExisting`), but only when the text is the agent's own briefing, because refreshing from
the fallback would clobber a human's edit.

## When the target repo ships a PR template, the briefing IS that template, filled in

`pr-template.ts` owns the discovery rules and the reasoning behind each. Neither host applies a
template to an API-created pull request (only to the web form a human opens), so nothing fails to
say so, and our PRs are the only ones on the repo missing the structure its reviewers read. The
AGENT fills it, in the prompt that already asks for a briefing: the sections are questions only
whoever did the work can answer, so stuffing the briefing under the first heading gives the
template's shape and none of its meaning.

## Three things are load-bearing beyond that module

- **It rides EVERY agent pass**, or a validation/reproduction REPAIR pass (a fresh agent still
  carrying the description guidance) replaces the filled template with a free-form briefing.
- **The sentinel is read with `titleFromHeading: false`**, because the headings are now the
  REPO's and `splitTitle`'s lone-`#` rule would retitle the PR after the template's top heading
  and delete it from the body; a new read site owes the same flag.
- **`pr-template.coverage.test.ts` CLASSIFIES every agent-running mode as PR-opening or not**,
  because a new PR-opening mode that skips this compiles and passes every behavioural test; it
  cannot anchor on `openPullRequest(`, which runs in the push phase long after the prompt was
  composed.

## Related

- The engine-managed section of the same PR body:
  [`pr-verification-report.md`](../../docs/initiatives/pr-verification-report.md).
- The untrusted-text rules every rendered PR surface obeys (host auto-links, fence escapes,
  `redactSecrets` at compose time): CLAUDE.md, "Untrusted text crossing a rendered surface", and
  [`security-model.md`](./security-model.md).
