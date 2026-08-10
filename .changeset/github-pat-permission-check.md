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

**Which token gets judged, and whether one is judged at all.** The check resolves through the same
`resolveRunInitiatorToken` the dispatch mint and the engine's GitHub client already share, now
surfaced on `CoreDependencies`, so a workspace that turned `allowInitiatorPat` off is not nagged
about a credential none of its runs touch. Re-deriving the gate in the controller was the
alternative, and it would have been a fourth copy of a security decision that exists to be singular.

The second half of that question is answered by a new `listWorkspaceRunRepos` seam, the block-free
counterpart of `resolveRepoTarget`, built beside it on every facade: every repository this board's
mounted services target. A token is judged only where a run would present it, so a board that
targets no GitHub repository (bound to GitLab, or nothing linked yet) answers `not_applicable`
rather than rendering a scope verdict over pipelines that never reach GitHub. The same set is what
a fine-grained token is probed against, so the probe's cap samples the work rather than the
alphabet: the repository projection lists everything the connection can see and is ordered by owner
and name, which no run consults.

**Per capability, not a boolean.** GitHub reports a classic token's scopes in `x-oauth-scopes` and
reports nothing whatsoever for a fine-grained one, whose reach is knowable only by probing a
repository: that answers for push and answers nothing for pull requests or workflows. Each
capability therefore carries `granted` / `missing` / `unknown`, and only `missing` raises anything.
Folding `unknown` into either would have meant silencing a real gap or nagging every correctly
configured fine-grained deployment forever. The fine-grained probe is a capped sample of the
targeted repositories and says how many it did not read.

**What a repository read can and cannot establish.** GitHub's repository payload reports the
authenticated IDENTITY's role, not the grants of the credential presenting it, and a token's reach
is a subset of its owner's. So `push: false` refutes the token while `push: true` only fails to
refute it, and only the first is reported as a verdict. The one positive statement available about
the credential itself is a 404, which GitHub returns rather than a 403 for a repository a
credential may not see; a 404 on every targeted repository is therefore `missing`, and the report
names those repositories, which is the fine-grained-token-pointed-at-the-wrong-repositories case
this feature exists to catch. A single 404 among readable repositories stays `unknown`: it is
ambiguous with a projection row pointing at a renamed repository, and a stale row must not be
reported as a broken credential.

**A throttled token is not a rejected one.** GitHub spells an exhausted primary or secondary rate
limit with the same 403 it uses to refuse a credential, so the rate-limit markers are read first
and answer `probe_failed`. Read as a rejection, a throttled board load raises the loudest banner
the product has and advertises minting a replacement.

**A classic token with no scopes is a distinct fact from an unreadable one.** GitHub sends
`x-oauth-scopes` for every classic token, so an empty value states that this one grants nothing.
Treating an empty header as an absent one classified it as unreadable, which sent it down the
fine-grained path where a repository read its owner could satisfy reported it as fine. It now
classifies as a classic token missing everything, and the connect form gained a warning
(`github_pat_no_scopes`) saying so.

**The scope list is not on the wire.** Nothing renders it, reads pass the route's permission mount,
and the one source whose scopes this endpoint could expose is a shared deployment credential.

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

**On the SPA side**, the check is single-flighted separately from the connection reads and never
awaited by them. It is the only one of the three that leaves the deployment, and two modals block
their open on `probe()`; awaited, an unreachable GitHub held those modals for the full outbound
timeout to settle a banner they do not render. It follows the door rather than the batch: the
on-board-open fan-out checks at most once per board, while the deliberate-refresh door re-checks,
because the surfaces that force a refresh are the ones that just changed what the answer depends
on. Three panels whose own comments said "probe once so the pickers light up" moved onto
`ensureProbed`, which is what they meant.

The required-scope list is now one constant in `@cat-factory/contracts`, read by the local
facade's boot warning and setup link, its scope classifier, and the SPA — it was two copies before,
which is two answers to "what should I tick".
