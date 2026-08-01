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
at all — the agent runs as your own user on your own machine, and the boundary is only whatever
sandboxing the agent CLI itself applies. See item 5 of the operator hardening checklist.

## Layer 3 — what the token can reach (mechanism)

This is the hard bound on a _fully_ compromised run. What the token is varies by deployment shape:

| Deployment shape           | Credential on the job                                                   | Scope                                                                                                                                      | Lifetime                |
| -------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------- |
| Cloudflare / Node engine   | GitHub App installation token minted at dispatch (`GitHubAppAuth`)      | **Installation-wide**: every repo the workspace's installation covers, at the permissions the install granted (Contents: read/write, etc.) | ~1h, in-memory only     |
| Mothership-mode local node | Repo-scoped mint over the delegation RPC (`GitHubDelegationController`) | **Repo-scoped** (`repository_ids`): only the App-linked repos in the account's scope; empty scope ⇒ denial; every mint audit-logged        | ~1h, minted per request |
| Local mode (PAT)           | The deployment's shared `GITHUB_PAT`                                    | Whatever the human who created the PAT gave it                                                                                             | The PAT's own           |

GitLab connections (any deployment shape) authenticate with a **per-workspace PAT**, stored sealed by
the deployment `SecretCipher` and unsealed server-side per use — like the local-mode row, its scope
and lifetime are whatever the human granted the PAT, so the fine-grained-PAT advice below applies.

Consequences to internalize:

- Worst case for a compromised container run is **pushes to repos the installation already covers,
  for under an hour**. No lateral movement to other installations or accounts, and nothing to steal
  at rest — tokens are never persisted.
- The token carries `Contents: write` **for the whole repo**. GitHub App tokens cannot be
  branch-scoped, so _nothing platform-side_ stops a stolen token from pushing directly to an
  unprotected default branch. **Branch protection on the host is the control for that, and it is
  yours to configure** (see the checklist).
- In local PAT mode the platform inherits the PAT's blast radius. A classic-scope PAT that can push
  to everything you own is exactly that dangerous in this context; use a fine-grained PAT restricted
  to the repos the deployment works on.

Known gap, candidate hardening: the standard engine dispatch uses the **unscoped** installation
token, even though the repo-scoped mint mechanism already exists (the mothership delegation path
uses it). Narrowing the job token to the run's actual repos (primary + peers + references) would
shrink the worst case of Layer 2's stated limit from "the installation" to "the repos this run was
about". Until then, the practical mitigation is installation scope itself — see the checklist.

## Layer 4 — nothing the agent controls merges to the default branch (mechanism + configuration)

Pushing a malicious commit to a `work` branch is, by design, _allowed_ — that is what a PR is for.
The enforcement that matters is that no agent has a path to **merge** it:

- The `merger` agent returns **only a JSON assessment** (complexity / risk / impact scores plus
  rationale). It makes no commits and calls no merge API. The real merge is executed by the engine
  (`MergeResolver` / `finalizeMerge` in `@cat-factory/orchestration`), server-side, with the
  server's credential — the container never holds a token during the merge decision.
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
   `Contents: write` token, and it lives on the host, not in this codebase. The platform never
   needs to push to a protected default branch (bootstrap targets an empty repo; everything else is
   work branches), so protection costs nothing.
2. **Choose merge presets deliberately.** For anything sensitive: pin `Manual review only`, or keep
   auto-merge and add class floors for `source` and `schema`. Remember the shipped default
   auto-merges under Balanced ceilings with no floors.
3. **Scope the GitHub App installation to only the repos the platform should work on.** The job
   token is installation-wide, so the installation _is_ the blast radius of a fully compromised
   run. Don't install on "All repositories" of an org that also holds crown jewels.
4. **In local PAT mode, use a fine-grained PAT** restricted to the working repos. The platform
   inherits the PAT's whole scope.
5. **Treat local native mode (`LOCAL_NATIVE_AGENTS`) as trusted-input only.** No container means
   Layers 1–2 thin down to the agent CLI's own sandboxing; don't point native-mode runs at
   repositories or issues whose content you don't trust.
6. **Self-hosted runner pools execute jobs with these tokens** — the pool host is inside the trust
   boundary. Run pools on infrastructure you'd trust with the installation token itself
   (`runner-pool-integration.md`, ADR 0026 for the warm-pool isolation hazard).
7. **Make your CI test what you care about.** The CI gate is exactly as strong as the checks it
   reads.

## Known gaps (honest list, with candidate fixes)

- **Job tokens are installation-wide on the standard dispatch path.** The repo-scoped mint exists
  (delegation path) and could be applied at engine dispatch. Until it is, item 3 above is the
  mitigation.
- **No branch-protection preflight.** The platform could probe and warn when a linked repo's
  default branch is unprotected, instead of relying on the operator to know item 1. Today it does
  not; nothing in-product tells you that gap exists.
- **Intra-container credential compartmentalization is best-effort** (Layer 2's stated limit). A
  hard fix (separate uid for the agent process, or a push executed outside the container entirely)
  is a container-image and transport change, not a policy change.
- **The merger reads attacker-influenced text** and there is no adversarial-input hardening beyond
  the computed-class floors and ceilings. Deployments that want defence-in-depth here should use
  class floors (configuration, available today) rather than waiting for prompt-level fixes.

If you change anything on the write path — token minting, the push, the merge decision, or a
rendered surface — this document is part of the change: keep the layer descriptions and the gap
list truthful, in both directions.
