---
'@cat-factory/integrations': patch
'@cat-factory/orchestration': patch
'@cat-factory/local-server': patch
'@cat-factory/node-server': patch
'@cat-factory/contracts': patch
'@cat-factory/server': patch
'@cat-factory/worker': patch
'@cat-factory/kernel': patch
'@cat-factory/app': patch
---

Warn on board load when the GitHub token a run would use cannot push or open pull requests.

A personal access token is the operational credential on two deployment shapes: local mode, where
one token is both the sign-in identity and what every agent step clones, pushes and merges with,
and a hosted deployment whose run initiator stored a `github_pat`, which outranks the App
installation on the run path. On both, a token minted without `repo` (or a fine-grained token
pointed at the wrong repositories) reached its first failure several steps into a pipeline, as a
403 out of a container, after the run had already spent money. Local mode logged a boot warning
about it, which is a line in a terminal nobody is looking at; a hosted deployment said nothing at
all.

A new `GET /workspaces/:id/github/pat-check` answers what that token can actually do, and the SPA
raises a banner linking straight to GitHub's token form, pre-filled where GitHub allows it.

The parts worth reviewing:

**Which token gets judged.** The check resolves through the same `resolveRunInitiatorToken` the
dispatch mint and the engine's GitHub client already share, now surfaced on `CoreDependencies`, so
a workspace that turned `allowInitiatorPat` off is not nagged about a credential none of its runs
touch. Re-deriving the gate in the controller was the alternative, and it would have been a fourth
copy of a security decision that exists to be singular.

**Per capability, not a boolean.** GitHub reports a classic token's scopes in `x-oauth-scopes` and
reports nothing whatsoever for a fine-grained one, whose reach is knowable only by probing a
repository: that answers for push and answers nothing for pull requests or workflows. Each
capability therefore carries `granted` / `missing` / `unknown`, and only `missing` raises anything.
Folding `unknown` into either would have meant silencing a real gap or nagging every correctly
configured fine-grained deployment forever. The fine-grained probe is a capped sample of the linked
repositories and says how many it did not read.

**What does not raise the banner.** An unreachable GitHub is `probe_failed`, not a verdict: the
remedy a permissions banner advertises is wrong and expensive during an upstream blip. A missing
`workflow` scope is advisory, listed inside the card but never its reason for opening, because
without it a run still pushes, opens its PR and merges and fails only on changes that touch
`.github/workflows/*`.

**Classic versus fine-grained.** The re-mint link carries over the kind of the token being
replaced, so a deployment that standardised on fine-grained tokens is not pushed back to a classic
one by a warning. Only the classic form accepts a prefill; GitHub's fine-grained form takes no
permission parameters at all, so that half is a bare link and the banner names the permissions to
grant. Saying so is deliberate: a link that silently arrived with nothing selected reads as
"already done for you".

The required-scope list is now one constant in `@cat-factory/contracts`, read by the local
facade's boot warning and setup link, its scope classifier, and the SPA — it was two copies before,
which is two answers to "what should I tick".
