# Security model: agents, prompt injection, and the VCS write path

Agents on this platform read untrusted text (repository contents, issue and tracker text, PR
comments, web search results) and can open pull requests against real repositories. This document
answers one question precisely: **if a prompt injection or a hallucinated argument makes an agent
try to land malicious code, what actually stands between that decision and your repository?**

The answer is a chain of controls, and they are not all the same kind of thing. Each layer below is
labelled as one of:

- **mechanism** — enforced by code or by the VCS host; holds even against a fully adversarial agent
  process;
- **configuration** — enforced only if the operator sets it; the platform ships a default;
- **judgment** — an LLM's assessment; assumed to be defeatable by prompt injection, and therefore
  never the last line of defence for anything that matters.

Audience: operators deciding how much to trust autonomous runs, and contributors changing anything
on the write path. Related: [github-integration.md](./github-integration.md) (App setup and token
plumbing), [ADR 0025](./adr/0025-workspace-rbac.md) (who may trigger runs at all), and the
"Untrusted text crossing a rendered surface" and "Harness rules" sections of the root `CLAUDE.md`
(contributor-facing rules that keep these properties true).

## Threat model

Assume the worst case: an agent whose instructions have been fully subverted by text it read, or
whose tool calls carry hallucinated arguments. Concretely, assume the agent process inside the
executor container is **adversarial** — it will run any shell command its tools allow, and its
prompt-level restrictions (its instructions, `allowedTools`, "read-only" role descriptions) have
already failed. The question is what it can still reach.

Out of scope here: attacks on the platform's own HTTP surface (see the RBAC ADR and `auth.md`),
malicious operators, and a compromised VCS host.

## The write path, end to end

```
agent edits files in a per-run checkout
  → harness commits + pushes to ONE backend-chosen work branch     (mechanism)
  → harness opens a PR via the VCS API                             (mechanism)
  → CI gate reads the host's real check runs                       (mechanism + your CI)
  → merger agent returns a JSON risk assessment — nothing else     (judgment)
  → engine compares assessment to the merge preset and merges,
    or routes to a human                                           (mechanism + configuration)
  → the host performs the merge, under branch protection           (configuration, host-side)
```

That is the path an agent's DECISIONS travel. A run that has taken the credential itself (Layer 2's
stated limit) does not travel it at all — it reaches the host directly, where only branch protection
is left. Keep the two cases apart when reading what follows: every label below describes the pipeline
case unless it says otherwise.

The layers, in order of where they bite:

## Layer 1 — the agent never composes git commands (mechanism)

The agent's tool loop only edits files in the checkout. Every git operation — clone, branch,
commit, push — is executed by the **harness**, not the agent, via `execFile('git', [...])` with a
fixed argv and no shell (`backend/internal/executor-harness/src/git.ts`). The push is exactly
`git push -u origin <branch>` (`pushBranch`), and the branch name comes off the **job body composed
by the backend at dispatch** (`job.pushBranch ?? job.newBranch ?? job.branch`), never from model
output. A hallucinated "argument" in the model's reply therefore has nowhere to become a remote, a
branch, a refspec, or a flag.

Where a model-authored string legitimately must become a git or shell argument (the declared test
paths in the bugfix reproduction proof, tracker board slugs), it is validated for **git magic, not
just path traversal** — `isSafeTestPath` rejects wildcards and `:(...)` pathspec magic, and a
refused input is reported as an omission, never silently dropped
(`backend/internal/executor-harness/src/reproduction-proof.ts`).

## Layer 2 — the credential is not in the agent's environment (mechanism, with a stated limit)

The push token never appears in a remote URL, in git argv, or in the harness's `process.env`. Git
authenticates through a `GIT_ASKPASS` helper reading `GIT_ASKPASS_TOKEN`, which is set **only on the
env of each git child process the harness itself spawns** (`authEnv` in `git.ts`). The agent CLI is
spawned with the harness's inherited env plus explicit per-job extras — the token is not among them.
An injected agent that runs `git push` from its own shell finds a remote with no credential and
`GIT_TERMINAL_PROMPT=0`, so the push fails instead of prompting.

**The stated limit:** the agent and the harness share a container and a user. A sufficiently
determined adversarial process could scrape the token from harness memory or shadow the `git` binary
on `PATH` before the harness's own push. Treat this layer as least-privilege hygiene that defeats
casual and accidental exfiltration; the **container is the trust boundary**, and what a stolen token
is worth is bounded by Layer 3, not by this one.

This layer is at its weakest in **local native mode** (`LOCAL_NATIVE_AGENTS`): there is no container
at all — the agent runs as your own user on your own machine, so the process boundary above is only
whatever sandboxing the agent CLI itself applies. See item 5 of the operator hardening checklist.

What does still hold there is the **env allow-list** (`backend/runtimes/local/src/childEnv.ts`).
Spawned with a plain `...process.env`, a native child would inherit the ORCHESTRATOR's whole
environment — `DATABASE_URL`, `ENCRYPTION_KEY`, `AUTH_SESSION_SECRET`, `GITHUB_PAT`, provider API
keys — and hand it to a prompt-injectable agent subprocess that has shell access. So native children
get an allow-list PROJECTION instead: `PATH`/`HOME`/locale/temp/proxy/TLS-trust vars and the ambient
CLIs' own config homes, nothing else. **That list is a security boundary, not ergonomics** — adding a
secret-bearing name to `EXACT_ALLOW`/`PREFIX_ALLOW` hands it to every native agent run. The
deploy-harness transport opts out deliberately (`envMode: 'inherit'`, because kubectl/helm need
ambient cloud env), which is exactly why that transport is not for untrusted input either.

## Layer 3 — what the token can reach (mechanism)

This is the hard bound on a _fully_ compromised run. What the token is varies by deployment shape:

| Deployment shape           | Credential on the job                                                   | Scope                                                                                                                                      | Lifetime                |
| -------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------- |
| Cloudflare / Node engine   | GitHub App installation token minted at dispatch (`GitHubAppAuth`)      | **Installation-wide**: every repo the workspace's installation covers, at the permissions the install granted (Contents: read/write, etc.) | ~1h, in-memory only     |
| Mothership-mode local node | Repo-scoped mint over the delegation RPC (`GitHubDelegationController`) | **Repo-scoped** (`repository_ids`): only the App-linked repos in the account's scope; empty scope ⇒ denial; every mint audit-logged        | ~1h, minted per request |
| Local mode (PAT)           | The deployment's shared `GITHUB_PAT`                                    | Whatever the human who created the PAT gave it                                                                                             | The PAT's own           |

**The initiator's personal PAT OUTRANKS whichever row applies.** Wherever the per-user secret store
is wired (it needs `ENCRYPTION_KEY`), a run whose initiator has stored a personal GitHub PAT
(`github_pat`, sealed, opt-in per user) uses THAT token instead of the deployment's own: the
container push/clone mint checks it first (`container-executor-deps.ts`, both facades), and so does
the engine's own GitHub client via `PatPreferringAppRegistry` — which covers the CI gate,
mergeability, and the real merge call. The deployment credential is the fallback, not the default.

The purpose is attribution: pushes and PRs come from the human who started the run rather than from
the bot. The security consequence is that **the bound is then the PAT's scope, not the
installation's** — and a classic-scope personal PAT is broader than any installation, reaching
repositories the platform was never installed on. So the blast radius of a compromised run is a
property of the run's INITIATOR, not only of how the operator scoped the deployment. Treat "who may
start runs" (ADR 0025) and "what PATs those members store" as one question.

GitLab connections (any deployment shape) authenticate with a **per-workspace PAT**, stored sealed by
the deployment `SecretCipher` and unsealed server-side per use — like the local-mode row, its scope
and lifetime are whatever the human granted the PAT, so the fine-grained-PAT advice below applies.

Consequences to internalize:

- Worst case for a compromised container run is **pushes to repos the credential already covers, for
  as long as it lives** — under an hour for an App token; indefinitely, and possibly far wider, for a
  personal PAT. App tokens buy no lateral movement to other installations or accounts and leave
  nothing to steal at rest (never persisted); a stored PAT is at rest by definition, sealed, and is
  only as narrow as the member made it.
- The credential carries `Contents: write` **for the whole repo**, and GitHub App tokens cannot be
  branch-scoped. So _nothing platform-side_ stops a stolen token from pushing directly to an
  unprotected default branch — nor from **merging an open PR through the host's merge API**, which
  needs no more permission than the push already had. **Branch protection on the host is the control
  for both, and it is yours to configure** (see the checklist). This is also why Layer 4 below is
  conditional on Layer 2 rather than a defence in its own right.
- In local PAT mode the platform inherits the PAT's blast radius. A classic-scope PAT that can push
  to everything you own is exactly that dangerous in this context; use a fine-grained PAT restricted
  to the repos the deployment works on. The same advice applies, per member, to stored personal PATs.

Known gap, candidate hardening: the standard engine dispatch uses the **unscoped** installation
token, even though the repo-scoped mint mechanism already exists (the mothership delegation path
uses it). Narrowing the job token to the run's actual repos (primary + peers + references) would
shrink the worst case of Layer 2's stated limit from "the installation" to "the repos this run was
about". Until then, the practical mitigation is installation scope itself — see the checklist. Note
that such a narrowing would not bound an initiator PAT, which the platform does not mint and cannot
scope.

## Layer 4 — no agent DECISION merges to the default branch (mechanism + configuration, given Layer 2)

Pushing a malicious commit to a `work` branch is, by design, _allowed_ — that is what a PR is for.
The enforcement here is that nothing an agent **decides** or **returns** can merge it.

Read the scope of that claim precisely, because it is the layer most easily over-read. This layer
constrains the agent's OUTPUT — the text and scores it returns, and the pipeline that consumes them.
It does not constrain a container process that has **taken the credential** in the sense of Layer 2's
stated limit: that process can call the host's merge API directly and never touch this pipeline at
all. So Layer 4 is a real mechanism against a subverted agent making a bad _decision_, and no defence
whatsoever against a subverted agent that stole a _token_. Only branch protection (checklist item 1)
covers the second case.

With that scoping, the pipeline properties are:

- The `merger` agent returns **only a JSON assessment** (complexity / risk / impact scores plus
  rationale). It makes no commits and calls no merge API. The real merge is executed by the engine
  (`MergeResolver` / `finalizeMerge` in `@cat-factory/orchestration`), server-side, with the server's
  credential, on a code path the container cannot reach or influence except through those scores.
  Note that the merger container is _not_ credential-free: it is a container agent kind that clones
  the PR head to read the diff, so its job carries the same clone/push token as any other dispatch
  (`CONTAINER_AGENT_KINDS`). What it lacks is a way to make the ENGINE merge; what a stolen token
  could still do is the Layer 2/3 story above, not this one.
- The inputs the agent cannot game are deliberate **mechanisms**: the change **class**
  (`docs < test < dependency < config < source < schema`) is computed in backend TypeScript from
  the actual VCS diff, never read off the model's reply; an unreadable diff classifies as `unknown`,
  and **`unknown` never matches a class rule**, so a VCS outage cannot loosen policy.
- The **merge preset** is configuration, resolved server-side (block pin → workspace default →
  built-in): `autoMergeEnabled: false` routes _every_ PR to a human `merge_review` regardless of
  scores, and per-class `classRules` put floors under the model's opinion (e.g. "schema-class
  changes always get a human"). A class rule can never override `autoMergeEnabled: false`.
- The **CI gate** reads the host's real check runs — your CI is a mechanism here, to exactly the
  extent your CI actually tests things.
- **Human gates cannot be triaged away by a model.** Estimate gating may _add_ a human checkpoint
  but never cancel one the pipeline author placed (`assertValidGating` refuses a step carrying both
  a human gate and enabled gating), and `merger` is not a gatable kind, so a model's own estimate
  cannot skip the merge decision.

The **judgment** component is the merger's scores themselves: the model reads the diff, and the
diff is attacker-influenced text. An injected diff can try to talk its own risk score down. That is
precisely why the ceilings and class floors exist and why they key on the _computed_ class — but it
also means the shipped default posture is worth stating plainly:

> **Default posture ("Balanced" preset):** auto-merge is ON, with ceilings
> `complexity ≤ 0.5, risk ≤ 0.4, impact ≤ 0.5` and **no per-class floors**. Out of the box, a
> source- or schema-class change that a (possibly manipulated) merger scores under those ceilings
> merges without a human — subject to your CI and your branch protection. If that is not acceptable
> for a repo, pin the `Manual review only` preset or add class floors. This is a one-line
> configuration, not a code change.

## Layer 5 — agent text is untrusted on every rendered surface (mechanism)

Everything the agent writes that reaches a parsed surface is treated as hostile:

- PR bodies, descriptions and the verification report are scrubbed with `redactSecrets` **at
  compose time** (before truncation), capped, and passed through `hostMarkdown`, which neutralizes
  the host's auto-link triggers — so injected output cannot smuggle a `Closes #N` that deletes an
  issue on merge, break out of a fence to overwrite the machine-read report block, or echo a
  credential a subprocess error leaked into it.
- Captured command output shown back to a model is fenced with a fence sized longer than any
  backtick run in the body (`fencedOutput`), so tool output cannot spill into what the model reads
  as instructions.
- Inbound tracker-comment commands are explicit first-token commands only, behind identity,
  data-not-instructions, and iteration-budget guards, and route through the same service methods
  the UI calls — there is no parallel webhook-driven mutation path into the engine.

## What is deliberately NOT a security boundary

Do not lean on any of these; the codebase explicitly refuses to:

- **`allowedTools` and agent instructions.** Tool allow-lists are scoping for focus, not
  containment (`custom-agents.md` states this outright). A "read-only" role is a prompt.
- **The merger's judgment**, or any other LLM verdict, for anything the preset and class rules
  don't floor. Judgments are defeatable by the same injection you're worried about.
- **Intra-container separation** between agent and harness (Layer 2's stated limit).
- **The absence of a secret in the prompt.** Injected `.cat-context/` files and job bodies carry
  non-secret projections by design (`context.toolServers` never carries credential values; tool
  secrets ride the job body only, resolved by name through `ToolSecretResolver`), but anything the
  agent can read, assume it can also try to exfiltrate through text it writes — which is why
  Layer 5 scrubs at every exit.

## Operator hardening checklist

In priority order. The first two are the ones that decide whether "malicious code reaches `main`"
is possible at all:

1. **Protect the default branch of every repo the installation covers** (required). Require PRs,
   forbid direct pushes, require your CI checks. This is the _only_ control over a stolen
   `Contents: write` token — covering both a direct push and a merge-API call — and it lives on the
   host, not in this codebase. The platform never needs to push to a protected default branch
   (bootstrap targets an empty repo; everything else is work branches), so protection costs nothing.
2. **Choose merge presets deliberately.** For anything sensitive: pin `Manual review only`, or keep
   auto-merge and add class floors for `source` and `schema`. Remember the shipped default
   auto-merges under Balanced ceilings with no floors.
3. **Scope the GitHub App installation to only the repos the platform should work on.** The job
   token is installation-wide, so the installation is the blast radius of a fully compromised run —
   whenever the run is using the App token at all, which item 4 is about. Don't install on "All
   repositories" of an org that also holds crown jewels.
4. **Govern stored personal PATs, or item 3 does not bind.** An initiator's stored `github_pat`
   outranks the App token on the standard dispatch path, so a member with a classic-scope PAT
   silently widens every run they start to their own whole account. Ask members to store
   fine-grained PATs limited to the working repos, or leave the personal-PAT slot empty and accept
   bot attribution. The same fine-grained advice covers local mode's shared `GITHUB_PAT` and a
   workspace's GitLab PAT, where the platform inherits the PAT's whole scope.
5. **Treat local native mode (`LOCAL_NATIVE_AGENTS`) as trusted-input only.** No container means the
   process boundary is only the agent CLI's own sandboxing — the env allow-list still strips the
   orchestrator's secrets, but nothing stops a subverted agent from reading your filesystem. Don't
   point native-mode runs at repositories or issues whose content you don't trust.
6. **Self-hosted runner pools execute jobs with these tokens** — the pool host is inside the trust
   boundary. Run pools on infrastructure you'd trust with the installation token itself
   (`runner-pool-integration.md`, ADR 0026 for the warm-pool isolation hazard).
7. **Make your CI test what you care about.** The CI gate is exactly as strong as the checks it
   reads.

## Known gaps (honest list, with candidate fixes)

- **Job tokens are installation-wide on the standard dispatch path.** The repo-scoped mint exists
  (delegation path) and could be applied at engine dispatch. Until it is, item 3 above is the
  mitigation.
- **An initiator's personal PAT is unbounded by anything the platform controls**, and it takes
  precedence over the App token precisely on the path this document is about. The platform stores it
  sealed and never logs it, but it cannot narrow it: `repository_ids` scoping is an App-token
  mechanism with no PAT equivalent. Candidate hardening is to surface the granted scope at the point
  a member saves a PAT (so an over-broad classic token is visible rather than silent), and to let a
  workspace refuse personal-PAT preference entirely and always run as the App. Neither exists today;
  item 4 above is a policy mitigation, not an enforced one.
- **No branch-protection preflight.** The platform could probe and warn when a linked repo's
  default branch is unprotected, instead of relying on the operator to know item 1. Today it does
  not; nothing in-product tells you that gap exists.
- **Intra-container credential compartmentalization is best-effort** (Layer 2's stated limit). A
  hard fix (separate uid for the agent process, or a push executed outside the container entirely)
  is a container-image and transport change, not a policy change.
- **The merger reads attacker-influenced text** and there is no adversarial-input hardening beyond
  the computed-class floors and ceilings. Deployments that want defence-in-depth here should use
  class floors (configuration, available today) rather than waiting for prompt-level fixes.

If you change anything on the write path — token minting or credential PRECEDENCE, the push, the
merge decision, a rendered surface, or the native-child env allow-list — this document is part of the
change: keep the layer descriptions and the gap list truthful, in both directions. "In both
directions" is not a formality: this document has already been wrong by over-claiming a boundary
(Layer 4 read as unconditional) and by under-claiming one (the native env allow-list going
unmentioned), and each error misleads a different reader.
