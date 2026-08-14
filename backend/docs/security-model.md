# Security model: agents, prompt injection, and the VCS write path

Agents on this platform read untrusted text (repository contents, issue and tracker text, PR
comments, web search results, and the results of any MCP tool server wired for the run) and can
open pull requests against real repositories. This document
answers one question precisely: **if a prompt injection or a hallucinated argument makes an agent
try to land malicious code, what actually stands between that decision and your repository?**

The answer is a chain of controls, and they are not all the same kind of thing. Each layer below is
labelled as one of:

- **mechanism**: enforced by code or by the VCS host; holds even against a fully adversarial agent
  process;
- **configuration**: enforced only if the operator sets it; the platform ships a default;
- **judgment**: an LLM's assessment; assumed to be defeatable by prompt injection, and therefore
  never the last line of defence for anything that matters.

Audience: **contributors changing anything on the write path.** The operator-facing account (the
same layer taxonomy, what is deliberately not a boundary, the hardening checklist and the known
gaps in the shape an operator acts on) is the website's
[Security Model & Hardening](https://www.catfactory.ai/reference/security-model.html); this page
keeps the full layer-by-layer mechanism and the code it lives in. Related: [github-integration.md](./github-integration.md) (App setup and token
plumbing), [ADR 0025](./adr/0025-workspace-rbac.md) (who may trigger runs at all), and the
"Untrusted text crossing a rendered surface" and "Harness rules" sections of the root `CLAUDE.md`
(contributor-facing rules that keep these properties true).

## Threat model

Assume the worst case: an agent whose instructions have been fully subverted by text it read, or
whose tool calls carry hallucinated arguments. Concretely, assume the agent process inside the
executor container is **adversarial**: it will run any shell command its tools allow, and its
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
  → merger agent returns a JSON risk assessment - nothing else     (judgment)
  → engine compares assessment to the merge preset and merges,
    or routes to a human                                           (mechanism + configuration)
  → the host performs the merge, under branch protection           (configuration, host-side)
```

That is the path an agent's DECISIONS travel. A run that has taken the credential itself (Layer 2's
stated limit) does not travel it at all: it reaches the host directly, where only branch protection
is left. Keep the two cases apart when reading what follows: every label below describes the pipeline
case unless it says otherwise.

The layers, in order of where they bite:

## Layer 1: the agent never composes git commands (mechanism)

The agent's tool loop only edits files in the checkout. Every git operation (clone, branch,
commit, push) is executed by the **harness**, not the agent, via `execFile('git', [...])` with a
fixed argv and no shell (`backend/internal/executor-harness/src/git.ts`). The push is exactly
`git push [--force-with-lease=<branch>:<sha>] origin <sha>:refs/heads/<branch>` (`pushBranch`), and
the branch name comes off the **job body composed by the backend at dispatch**
(`job.pushBranch ?? job.newBranch ?? job.branch`), never from model output; both shas are read out
of the checkout's own refs. A hallucinated "argument" in the model's reply therefore has nowhere to
become a remote, a branch, a refspec, or a flag.

**The force is bounded by a lease, and the lease is bounded twice over.** The harness
checkpoint-pushes the agent's commits while it works, so it is its own competing writer: the agent
can amend a commit that is already on the branch, which a plain push then refuses. The optional
`--force-with-lease` is what lets that land, under two conditions that `workBranchLease` checks
together, because the lease alone bounds only one end of it:

1. the `<sha>` it expects is one **this pass itself pushed** (the source commit the push named), so
   a tip the run merely cloned is never leased against, and
2. the branch **still contains the tip this pass started from**, so a rewrite reaching below that
   tip is refused rather than leased over. Without this, a resumed run that had landed one
   checkpoint could force away the commits it resumed from.

Neither value derives from model output. So the widest thing a compromised run gains is the ability
to overwrite commits it itself published moments earlier, on the one branch it was already allowed
to push; a second writer's commits (another dispatch, a person) refuse the push as `(stale info)`,
a rewrite of an earlier run's work refuses as `(non-fast-forward)`, and any other ref is
untouchable. `--force` with no lease appears nowhere on this path (the only unconditional force in
the harness is the bootstrap `reinitAndPush` onto a repo the Worker pre-flighted as empty).

Where a model-authored string legitimately must become a git or shell argument (the declared test
paths in the bugfix reproduction proof, tracker board slugs), it is validated for **git magic, not
just path traversal**: `isSafeTestPath` rejects wildcards and `:(...)` pathspec magic, and a
refused input is reported as an omission, never silently dropped
(`backend/internal/executor-harness/src/reproduction-proof.ts`).

## Layer 2: the credential is not in the agent's environment (mechanism, with a stated limit)

The push token never appears in a remote URL, in git argv, or in the harness's `process.env`. Git
authenticates through a `GIT_ASKPASS` helper reading `GIT_ASKPASS_TOKEN`, which is set **only on the
env of each git child process the harness itself spawns** (`authEnv` in `git.ts`). The agent CLI is
spawned with the harness's inherited env plus explicit per-job extras: the token is not among them.
An injected agent that runs `git push` from its own shell finds a remote with no credential and
`GIT_TERMINAL_PROMPT=0`, so the push fails instead of prompting.

**The stated limit:** the agent and the harness share a container and a user. A sufficiently
determined adversarial process could scrape the token from harness memory or shadow the `git` binary
on `PATH` before the harness's own push. Treat this layer as least-privilege hygiene that defeats
casual and accidental exfiltration; the **container is the trust boundary**, and what a stolen token
is worth is bounded by Layer 3, not by this one.

The same shared user bounds AVAILABILITY, not just confidentiality: the agent may SIGNAL the harness,
which is PID 1 of the job container, and stop the very process supervising it. That is not fixable by
permissions here, because dropping the agent to a second uid needs a PID 1 running as root, which
this image deliberately does not have and managed container runtimes forbid. Two things are done
instead, and neither is a boundary. The harness does not answer to a pattern kill aimed at anything
else: it runs from `dist/harness-server.js` and renames itself to `cat-factory-harness`, which
rewrites both `/proc/<pid>/cmdline` and `comm`, so `pkill -f 'node dist/server.js'` and a bare
`pkill node` find only what the agent itself started (an agent scaffolding a Node service really did
match the old name and shut the harness down mid-job). And a harness that exits CLEANLY with a job
still running is reported as `harness_shutdown` rather than an eviction, so the platform states what
happened and does not spend an automatic retry reproducing it.

This layer is at its weakest in **local native mode** (`LOCAL_NATIVE_AGENTS`): there is no container
at all; the agent runs as your own user on your own machine, so the process boundary above is only
whatever sandboxing the agent CLI itself applies. See item 5 of the operator hardening checklist.

What does still hold there is the **env allow-list** (`backend/runtimes/local/src/childEnv.ts`).
Spawned with a plain `...process.env`, a native child would inherit the ORCHESTRATOR's whole
environment (`DATABASE_URL`, `ENCRYPTION_KEY`, `AUTH_SESSION_SECRET`, `GITHUB_PAT`, provider API
keys) and hand it to a prompt-injectable agent subprocess that has shell access. So native children
get an allow-list PROJECTION instead: `PATH`/`HOME`/locale/temp/proxy/TLS-trust vars and the ambient
CLIs' own config homes, nothing else. **That list is a security boundary, not ergonomics**: adding a
secret-bearing name to `EXACT_ALLOW`/`PREFIX_ALLOW` hands it to every native agent run. The
deploy-harness transport opts out deliberately (`envMode: 'inherit'`, because kubectl/helm need
ambient cloud env), which is exactly why that transport is not for untrusted input either.

### The second path between those two environments: a capability CREDENTIAL

`childEnv.ts` states the invariant on the path where the platform's environment and an agent's
process meet by INHERITANCE. There is one other path, and it is a deliberate one: a tool server, a
generative binary integration or a FOUNDATIONAL SERVICE declares the credential it needs BY NAME,
and the facade-wired `ToolSecretResolver` resolves it onto the job body, from where the harness
injects it into that one job's agent process. The platform's own resolver chain answers from the per-workspace credential
store first and falls back per key to `createEnvToolSecretResolver`, which reads the deployment's
own environment.

That mechanism is what makes an integration work with no new table, store or UI, and it is worth
keeping. What it must not do is carry the platform's OWN configuration across. A definition is
composition-root data that names both the key it wants AND the endpoint that key is sent to, so
`{ key: 'ENCRYPTION_KEY', usage: 'Authorization: Bearer <value>' }` was a registration that booted
clean and shipped the deployment's master sealing key to a third party. So:

- **A credential has TWO names and only one of them is a boundary.** The LOOKUP name (`key`) is
  what a resolver is asked for, so it is the one that can reach the deployment's environment. The
  INJECTION name (`envName`, defaulting to the lookup name) is what the value is set as inside the
  agent's or the MCP server's process, and it reads nothing. Everything below binds the lookup
  name. An `http` tool server always had this split (`key` is the lookup, `header` is where the
  value goes); `envName` is the same split for the stdio and generative-integration cases.
- **Only DEPLOYMENT CODE may declare one.** All three declarers are composition-root registries,
  and that is load-bearing rather than incidental: a declaration is a request to read a named value
  off the deployment's own environment (the fallback resolver) and hand it to an agent process, so
  the declarer must sit inside the same trust boundary as the process doing the reading. A
  foundational service is the only one of the three that ALSO has a REST write boundary, where the
  author is a workspace admin rather than the deployment, and there the two are not the same:
  `storedTierMayNotDeclareCredentials` refuses a credential on an account or workspace row, and the
  persisted record carries no field for one. The reserved-key floor below bounds what a declaration
  could reach even from code; it is a floor, not a licence, and it is not what stands between a
  tenant and the deployment's environment.
- **A capability credential may not be LOOKED UP BY a variable the platform reads**
  (`isReservedPlatformEnvKey`, `backend/packages/contracts/src/reserved-env-keys.ts`): the same
  exact-names-plus-prefix-families shape `childEnv.ts` uses, and case-insensitive for the same
  reason (`process.env` lookup is case-insensitive on Windows). Refused where the declaration is
  made (the generative-integration credential schema; boot validation for a tool server) AND at
  dispatch, because a **mothership-mode node boot-validates none of the definitions it resolves**:
  they arrive per dispatch over `/internal/binary-generators` and
  `/internal/foundational-services`, authored by a process one build ahead of it, against an
  environment that is a developer's own laptop. `ENCRYPTION_KEY` and
  `HARNESS_SHARED_SECRET` are the keys to the boundary BETWEEN those two processes, held by the
  side meant to keep them; that is what the floor protects, with no configuration.
- **The injection name carries a narrower rule, not the floor** (`isToolchainEnvName`): not `PATH`,
  `NODE_OPTIONS`, `npm_config_*` or anything else that reconfigures a process rather than
  authenticating a call. Holding it to the floor instead would have been the stricter-looking
  choice and the wrong one, because the floor's prefix families cover names the platform does not
  read and a vendor's own SDK does (`GITHUB_PERSONAL_ACCESS_TOKEN`, `SLACK_BOT_TOKEN`,
  `AWS_ACCESS_KEY_ID`). With one name for both jobs, the floor would have made the commonest MCP
  servers unusable, with no workaround open to a deployment, which is the same objection that ruled
  out mandating a `TOOL_` prefix on the lookup side.
- **An OAuth GRANT is the third shape of the same path, and it moves what a run authenticates AS
  rather than what it can read.** A remote (`http`) tool server may declare `oauth` instead of a
  static key; the platform then holds a per-workspace, sealed grant and mints an access token at
  dispatch, into the same job-body header channel a resolved `secretKeys` value uses. Four things
  keep it inside the boundary above. The OAuth CLIENT SECRET is looked up through the same chain and
  held to the same reserved-key floor, so nothing new can be named. The authorization and token
  endpoints are held to the tool-server URL rule whether DECLARED or DISCOVERED, because a metadata
  document is a third party naming where this deployment's client secret is posted. The `state` that
  carries the flow is SEALED rather than signed (it holds the PKCE verifier, which travels the same
  browser redirect the authorization code does) and binds the user who started it, so an
  authorization link opened by an admin cannot plant someone else's vendor account as the board's
  connection. And `secrets.manage` is re-resolved WHEN THE TOKEN IS STORED, not assumed from the
  Connect press, because a grant takes minutes of human time. Both of those last two are enforceable
  only because the vendor's redirect lands on the SPA, which re-presents the `code` and `state` to a
  session-gated endpoint: a backend route receiving a third-party browser navigation directly has no
  bearer token to resolve a user from, so it would have to sit outside the default-deny session gate
  and every check it made about the caller would be unreachable code. What OAuth does NOT change: a wired server's
  results are still untrusted input, and the granted SCOPES are the boundary that actually bounds
  what a subverted agent can do with the connection.
- **The dispatch-time check sits at the CALL SITE, not inside the env resolver**, so it holds for
  a deployment's own `ToolSecretResolver` too, which is the one that could genuinely have a value
  stored under such a name.
- **Everything outside the platform's own configuration is the deployment's call**, because only
  it knows which of a developer's variables (`AWS_PROFILE`, a personal token) an integration may
  see. That bound is `EnvToolSecretResolverOptions.allowKeys`, reachable through every facade's
  `createToolSecretResolver` option, the same seam a deployment uses to swap in a per-workspace
  sealed store or a secret manager. A deployment installing third-party agent packages, and a
  mothership-mode node, are the two cases that should set it. On the Worker that option registers
  the resolver PROCESS-WIDE, because container agents are dispatched by the durable driver, which
  builds its own container and would never see an option held on the app.

## Layer 3: what the token can reach (mechanism)

This is the hard bound on a _fully_ compromised run. What the token is varies by deployment shape:

| Deployment shape           | Credential on the job                                                   | Scope                                                                                                                                                                          | Lifetime                |
| -------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------- |
| Cloudflare / Node engine   | GitHub App installation token minted at dispatch (`GitHubAppAuth`)      | **Repo-scoped** (`repository_ids`): the repos THIS run resolved (primary + fan-out peers + conflict/merger siblings + reference repos), at the permissions the install granted | ~1h, cached per scope   |
| Mothership-mode local node | Repo-scoped mint over the delegation RPC (`GitHubDelegationController`) | **Repo-scoped**: the dispatch's own repos, intersected server-side with the App-linked repos in the account's scope; empty scope ⇒ denial; every mint audit-logged             | ~1h, minted per request |
| Local mode (PAT)           | The deployment's own source-control token                               | Whatever the human who created the PAT gave it                                                                                                                                 | The PAT's own           |

**Where local mode's own token comes from, and who may set it.** `GITHUB_PAT` / `GITLAB_PAT` in
the environment WIN; with neither set, the token is the one a developer pasted on the sign-in
screen, sealed on that machine under `ENCRYPTION_KEY` (`sqlite/vcsCredentialStore.ts`). That
install is reachable by an UNAUTHENTICATED caller by construction: it happens during sign-in,
before any session exists. Whoever can reach that screen can already sign in one click with the
token the deployment holds, so the SESSION is not a new door, and the flow closes the moment the
environment names a token. What IS new is that the same caller can REPLACE an
already-installed credential with one of their own, which re-points every subsequent clone, push
and PR at their account. That is deliberate — a revoked token would otherwise wedge the
deployment permanently, and the sign-in screen is the only surface a locked-out developer can
reach — and it is bounded to deployments whose environment names no token. What it does mean is that local
mode's existing boot warning is the real control — **the auth gate defaults open and the listener
binds to all interfaces, so anyone on your network can reach the API** (`AUTH_DEV_OPEN=false`, or
`HOST=127.0.0.1`). On a deployment reachable by people you do not trust, set the token in `.env`,
which shuts the browser flow off entirely.

**The App rows are narrowed by the ENGINE, at dispatch.** `jobTokenRepoIds` collects the repos one
job body names and `buildDispatchTokenMint` turns them into GitHub's `repository_ids`. A leg on a
different installation is dropped rather than requested: one job carries one token, so such a repo
is unreachable either way. A scope that cannot be expressed as repo ids widens to installation-wide
rather than dropping a leg the harness is about to clone, and says so: a `warn` naming the run plus
the `dispatch.token_scope_widened` counter, because a security property degrading silently reads
exactly like one holding.

**"A dispatch" means every path that hands a container a GitHub credential**, not just the step
executor: the repo bootstrapper, the env-config repairer, the frontend preview job and the deploy
clone target each name the one repo they touch. They go through the same builder on both facades,
so neither the two runtimes nor the five dispatchers can drift on whose token it is or how wide.
That totality is held by the TYPE rather than by review: supplying the run context is what makes a
mint a dispatch mint, and a context must carry `repoIds`. A dispatcher whose own lookup came back
empty passes an empty scope, which is a different fact from an engine call naming none, and is
reported as the widening it is. Engine calls (`RepoFiles` reads, the gate and merge clients) pass
no context at all and stay installation-wide, deliberately: they act as the deployment, not as a
run, and nothing they do reaches a container.

Two things this does NOT narrow, both by construction. **Permissions**: the token still carries
`Contents: write` for the repos it does cover, because GitHub App tokens cannot be branch-scoped.
**A personal PAT**: `repository_ids` is an App-token mechanism with no PAT equivalent, so a run on
the initiator's own token is bounded by that token; `allowInitiatorPat` is what bounds that.

**The initiator's personal PAT OUTRANKS whichever row applies, unless the workspace refuses it.**
Wherever the per-user secret store is wired (it needs `ENCRYPTION_KEY`), a run whose initiator has
stored a personal GitHub PAT (`github_pat`, sealed, opt-in per user) uses THAT token instead of the
deployment's own: the container push/clone mint checks it first (`container-executor-deps.ts`, both
facades), and so does the engine's own GitHub client via `PatPreferringAppRegistry`, which covers
the CI gate, mergeability, and the real merge call. The deployment credential is the fallback, not
the default.

**A public-API key can now BE an initiator, and that is how it reaches the rule above.** A key is
minted as one of two identities (`actsAsSelf`, [`public-api.md`](./public-api.md#1-mint-a-key)). A
**system** token — the default, and every headlessly-provisioned key — starts runs with
`initiatedBy: null`, so nothing here applies to it: no personal PAT is consulted and no personal
subscription can be unlocked, which is why an individual-usage model is refused outright rather
than charged to someone who is not present. A **personal** token carries its minter's `usr_*`, so
its runs are that person's in every sense this page describes: their PAT outranks the deployment's
by the same precedence, and their sealed subscription can be activated for the run.

Two properties bound that. The binding names **only the minter** (the wire field is a boolean and
the server reads the id off the session), so a workspace admin cannot mint a key onto a colleague's
credentials. And the subscription half additionally needs the **personal password on every call**,
which the platform never stores — so a leaked personal token reaches that user's PAT (exactly as a
leaked session would) but not their subscription. `allowInitiatorPat` governs the PAT half here as
it does everywhere else.

**`allowInitiatorPat` (per workspace, on by default) is the enforced control over that.** Turned
off, every run authenticates as the App installation (or, in local mode, the deployment's own
token) and the initiator's PAT is never even decrypted, so the blast radius goes back to being a
property of how the operator scoped the deployment rather than of who pressed start. It is a
**mechanism**, not advice: all three mint sites route through the one
`createResolveRunInitiatorToken` decision, and an unreadable settings row **fails closed** to the
App token with the cause logged. What it does NOT touch is a member's own token acting on their
own behalf in the UI (browsing their PAT-reachable repos in the picker): that is them reading
their own account, not the platform writing to someone else's.

The purpose is attribution: pushes and PRs come from the human who started the run rather than from
the bot. The security consequence is that **the bound is then the PAT's scope, not the
installation's**, and a classic-scope personal PAT is broader than any installation, reaching
repositories the platform was never installed on. So the blast radius of a compromised run is a
property of the run's INITIATOR, not only of how the operator scoped the deployment. Treat "who may
start runs" (ADR 0025) and "what PATs those members store" as one question.

GitLab connections (any deployment shape) authenticate with a **per-workspace PAT**, stored sealed by
the deployment `SecretCipher` and unsealed server-side per use: like the local-mode row, its scope
and lifetime are whatever the human granted the PAT, so the fine-grained-PAT advice below applies.

Consequences to internalize:

- Worst case for a compromised container run is **pushes to repos the credential already covers, for
  as long as it lives**: under an hour for an App token; indefinitely, and possibly far wider, for a
  personal PAT. App tokens buy no lateral movement to other installations or accounts and leave
  nothing to steal at rest (never persisted); a stored PAT is at rest by definition, sealed, and is
  only as narrow as the member made it.
- The credential carries `Contents: write` **for the whole repo**, and GitHub App tokens cannot be
  branch-scoped. So _nothing platform-side_ stops a stolen token from pushing directly to an
  unprotected default branch, nor from **merging an open PR through the host's merge API**, which
  needs no more permission than the push already had. **Branch protection on the host is the control
  for both, and it is yours to configure** (see the checklist). This is also why Layer 4 below is
  conditional on Layer 2 rather than a defence in its own right.
- In local PAT mode the platform inherits the PAT's blast radius. A classic-scope PAT that can push
  to everything you own is exactly that dangerous in this context; use a fine-grained PAT restricted
  to the repos the deployment works on. The same advice applies, per member, to stored personal PATs.

**What the platform can SAY about the token in use, and what it still cannot do.** The scope of a PAT
is not narrowable from here, so the only control left is the holder knowing what they handed over.
Three surfaces report it, from the same classification (`githubPatScope.ts`) and the same required-scope
list (`@cat-factory/contracts`' `GITHUB_PAT_CLASSIC_SCOPES`): the connect form's warnings when a token
is stored, the local facade's boot log, and a board-load check
(`GET /workspaces/:id/github/pat-check`) that resolves the token a run would ACTUALLY authenticate as
through the same `resolveRunInitiatorToken` the dispatch mint uses, so an `allowInitiatorPat` opt-out
is honoured rather than re-decided. It judges a token only where a run would PRESENT it: the
repositories the board's mounted services target are both the gate (none ⇒ nothing to judge, which is
the answer for a GitLab-bound or not-yet-linked board) and the probe set.

It answers per capability with a tri-state, because a CLASSIC token's scopes come back on
`x-oauth-scopes` while a fine-grained one reports nothing anywhere. What a repository read can
establish is asymmetric and reported that way: GitHub's repository payload names the authenticated
IDENTITY's role, and a token's grants are a subset of its owner's, so `push: false` refutes the token
while `push: true` only fails to refute it. A 404 is the one positive statement about the credential
itself (GitHub 404s rather than 403s on a repository a credential may not see), and a 404 on EVERY
targeted repository is reported as a missing capability: that is the fine-grained token pointed at the
wrong repositories.

The token's raw scope list is deliberately absent from that response. Reads pass the route's
permission mount, so publishing it would let any member read the breadth of a shared DEPLOYMENT
credential; the per-capability verdict is what a reader can act on.

Note what none of this changes: the check reads capability, it does not bound it, and a token that
passes it is still exactly as wide as the human who minted it made it.

So the worst case of Layer 2's stated limit is "the repos this run was about" rather than "the
installation", but only where the run authenticates as the App. Installation scope still bounds
what any run in the workspace could ever ask for, and it is what the checklist's item 3 is about;
it is now a ceiling rather than the blast radius of every single run.

### What a MACHINE token reaches: the one surface that answers with a plaintext credential

A mothership-mode node's machine token addresses a set of `/internal/*` endpoints, and all but one
of them answer with ciphertext, identifiers or events. `POST /internal/secrets/unseal` is the
exception: it returns an ORG credential in the clear (a provisioned environment's access handle, an
infra handler's secret bundle, a release-health connection), because the node is the process that
provisions that infrastructure and probes those monitors. Its bound is three things, in this order:

- **The audience pin.** A `machine` token only, checked before anything else, so no session, WS
  ticket or container token reaches it and its availability is not probeable.
- **The request names a ROW, never an envelope.** The mothership re-reads the row from its own
  store and opens THAT, so a caller cannot present ciphertext it obtained elsewhere. This is what
  keeps the endpoint from being a decryption oracle, and it is the same choice the notification
  relay made for the same reason.
- **The account scope, plus a CLOSED source table.** The workspace resolves to its owning account
  and anything outside the token's scope is a uniform 404. Within scope, `SEALED_SECRET_SOURCES`
  enumerates every readable row: seven sources today, each bound to one repository read, one record
  field and one HKDF tag. A source not in that table is unreachable, whatever the row is worth.
  The newest two are the DOCUMENT-source and TRACKER connections. They were the last integration
  outside this table, and not because the credential was more sensitive: their repositories
  decrypted INSIDE, so the row exposed no sealed field for a row-addressed unseal to name at all.
  Giving those rows an envelope is what admitted them, and it also let the connections themselves
  cross the persistence RPC as ciphertext, like every other connection surface.

Two properties of the answering deployment bound it further, and both are structural rather than
conventional. **Only a deployment holding its own main database serves the pair at all**, gated on
the `secretCipherFor` capability: a mothership-mode node would otherwise answer under the LOCAL key
that seals its own agent credentials, sealing rows the org can never open. And **no failure on this
path is logged through a bare message read**: every one is bound with kernel's `describeError`, so
`redactSecrets` runs over it first. This is the one surface whose SUBJECT is a credential, and a
driver or WebCrypto error routinely echoes back the value it choked on.

So the honest statement of the blast radius is: **a stolen machine token reads the org credentials
of the accounts it is scoped to, for the sources in that table.** That is strictly more than the
same token could read before, and strictly less than the mothership's `ENCRYPTION_KEY`, which still
never leaves the mothership: a revoked node loses the access at its next call, where a leaked key
would have been unrecoverable. The mitigation is the machine-node roster (revoke the node) and
keeping the table small, which is why widening it is a deliberate act rather than a routing detail.

The seal direction (`POST /internal/secrets/seal`) grants nothing further: encryption is not
decryption, and a caller in scope can already write arbitrary bytes into those fields through the
allow-listed repository `upsert`. It exists so a secret the NODE produces is sealed under the key
the ORG can read, rather than under a laptop key that would make the row unopenable by the
mothership's own teardown.

### What a CONTAINER token reaches beyond the model: two artifact routes

The container session token is minted per run, pinned to one workspace, execution, provider and
model, and its whole purpose is the LLM proxy. Two routes on the same base URL accept it, and
between them they are the only way a container reads or writes platform state without a repo
credential: `POST /v1/artifacts/ingest` (a browser-driven kind stores its captured screenshots) and
`GET /v1/artifacts/reference/:id` (that same kind downloads the task's reference designs into
`.cat-context/reference-screenshots/`).

Both resolve the account's store from the TOKEN's workspace rather than from the request, so a
container reaches only its own board's storage. The read route is bounded twice more, and the
second bound is the one worth stating: it serves `kind:'reference'` ONLY. A reference is design
material the platform deliberately handed this run; a `screenshot` is another run's output, and a
route that served both would turn one compromised container into a reader of every capture in the
workspace. Anything outside that is a 404 rather than a 403: a container has no business learning which
artifact ids exist. What remains inside the boundary is the workspace's own reference images, which
is the same class of data the run was dispatched with.

### What an MCP HOST reaches: the caller's own key, re-gated per call

`POST /api/v1/mcp` serves the public API as MCP tools, and its security model is deliberately
nothing of its own. The endpoint authenticates the same `cf_live_…` bearer every `/api/v1` call
takes, and each tool call becomes one in-process `/api/v1` dispatch (`http/loopback.ts`) under THAT
key, re-running the key gate and the per-operation scope rung, so nothing is reachable through a
tool that the same key could not reach with `curl`, and revoking the key severs the host. The
loopback forwards the caller's key verbatim and mints nothing, so the surface adds no credential of
its own to steal. Recursion is prevented by construction rather than by a guard: the tool table is
generated from the spec and the endpoint is deliberately absent from it, so no tool can name a path
that re-enters it; a future hand-authored or composed tool is what would break that argument.

Two residuals, stated rather than hidden: a legacy JSON-RPC batch fans one authenticated request
into N dispatches inside one invocation, each re-gated, so the fan-out is a cost exposure rather
than a bypass and the first shape to bound if the endpoint ever needs a limit
([`public-api.md`](./public-api.md#from-an-mcp-host)); and the serving side has no OAuth yet, so a
host holds a long-lived key in its own config, tracked as slice 7 of
[`mcp-maturation.md`](../../docs/initiatives/mcp-maturation.md).

## Layer 4: no agent DECISION merges to the default branch (mechanism + configuration, given Layer 2)

Pushing a malicious commit to a `work` branch is, by design, _allowed_: that is what a PR is for.
The enforcement here is that nothing an agent **decides** or **returns** can merge it.

Read the scope of that claim precisely, because it is the layer most easily over-read. This layer
constrains the agent's OUTPUT: the text and scores it returns, and the pipeline that consumes them.
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
  The merger container is _not_ credential-free: it is a container agent kind that clones
  the PR head to read the diff, so its job carries the same clone/push token as any other dispatch
  (it declares a `container-explore` surface on the agent-kind registry, like every other container
  kind). What it lacks is a way to make the ENGINE merge; what a stolen token
  could still do is the Layer 2/3 story above, not this one.
- The inputs the agent cannot game are deliberate **mechanisms**: the change **class**
  (`docs < test < dependency < config < source < schema`) is computed in backend TypeScript from
  the actual VCS diff, never read off the model's reply; an unreadable diff classifies as `unknown`,
  and **`unknown` never matches a class rule**, so a VCS outage cannot loosen policy.
- The **merge preset** is configuration, resolved server-side (block pin → workspace default →
  built-in): `autoMergeEnabled: false` routes _every_ PR to a human `merge_review` regardless of
  scores, and per-class `classRules` put floors under the model's opinion (e.g. "schema-class
  changes always get a human"). A class rule can never override `autoMergeEnabled: false`.
- **Who STARTED the run is part of the policy, pinned at admission.** A preset also carries
  `classRulesByRole` (the per-class rules narrowed by the initiator's workspace role) and
  `dryRunRoles` (roles whose runs open a PR but never merge, at either exit: the auto-merge AND the
  `mergePr` endpoint the review card calls). Both are MECHANISMS in the same sense as the class
  computation: the role and the mode are recorded on the run when it is admitted and read back from
  the stored row, so nothing the agent returns, and no preset edit made while the run works, can
  change the authority it runs under. Narrowing is subtractive by construction
  (`narrowMergeClassRule`), so a role entry can never widen what the base rules allow, and a run
  with no role to pin (a schedule fire, a public-API start, auth-disabled dev) stays on the base
  rules rather than being guessed onto a tier. A third field, `submissionClassesByRole`, allowlists
  the change classes a role may land at all and is refused at both exits too, so a tier can be held
  short of `source` without being sandboxed on everything; an absent entry is unrestricted and
  `unknown` stays inert there as well, for the same reason it does above. Full model:
  [ADR 0037](./adr/0037-role-scoped-merge-policy.md) and
  [ADR 0039](./adr/0039-role-scoped-submission-allowlists.md).
- **Which preset governs a task is part of the same policy, so SELECTING one is guarded too.**
  Editing a preset is admin-tier (`settings.manage`), but a task's `riskPolicyId` is an ordinary
  member-tier board write, which made re-pointing the task the way around a sandbox nobody had to
  edit. `refuseRiskPolicySelection` closes it with the narrow-only rule one level up: a selection
  may not drop a restriction the SELECTOR's own role was under (the sandbox, the submission
  allowlist, or a class the role layer narrowed), at every door that can re-decide it: creating a
  task, patching one, and moving one. That last is not a `riskPolicyId` write at all: the field
  resolves against the workspace that HOMES the task, so a cross-home reparent (dragging it into a
  service homed elsewhere, both mounted on the board) migrates the rows to a library where the
  source's preset is dangling and the destination's default governs instead. Same rule, with the
  workspace varying rather than the id, applied to every RUNNABLE block the move carries
  (`BLOCK_LEVEL_RUNS_PIPELINES`: tasks and initiatives, which start their own chains).
  Every workspace in that decision is a HOME, never the acting board, and so is every ROLE: a
  board mounts services homed elsewhere, the row is written at the home, and a run on it is
  admitted through that board under the tier the editor holds there, so the editor arrives as a
  `BlockEditAuthority` the guard asks per workspace. Judged against the acting board instead, an
  admin of a third board skips the check on two homes where they are a plain member.
  The arms run in the engine's own precedence order, so the reason it
  gives names the restriction the run itself would have been refused on. It compares only the ROLE
  layer, so choosing between presets that treat every initiator alike stays a plain member
  affordance.
- The **CI gate** reads the host's real check runs: your CI is a mechanism here, to exactly the
  extent your CI actually tests things.
- **Human gates cannot be triaged away by a model.** Estimate gating may _add_ a human checkpoint
  but never cancel one the pipeline author placed (`assertValidGating` refuses a step carrying both
  a human gate and enabled gating), and `merger` is not a gatable kind, so a model's own estimate
  cannot skip the merge decision.

The **judgment** component is the merger's scores themselves: the model reads the diff, and the
diff is attacker-influenced text. An injected diff can try to talk its own risk score down. That is
precisely why the ceilings and class floors exist and why they key on the _computed_ class, but it
also means the shipped default posture is worth stating plainly:

> **Default posture ("Balanced" preset):** auto-merge is ON, with ceilings
> `complexity ≤ 0.5, risk ≤ 0.4, impact ≤ 0.5` and **no per-class floors**. Out of the box, a
> source- or schema-class change that a (possibly manipulated) merger scores under those ceilings
> merges without a human, subject to your CI and your branch protection. If that is not acceptable
> for a repo, pin the `Manual review only` preset or add class floors. This is a one-line
> configuration, not a code change.

A second constant sits behind that one, and it is deliberately NOT the same policy.
`FALLBACK_RISK_POLICY` governs a run when NO preset resolves at all. It auto-merges nothing, so a
deployment that has configured no merge policy lands no pull request on a model's own scores.
`Balanced` is a row an operator could have read and changed; the fallback is the absence of any
such row, and absence of evidence is not evidence that auto-merging is wanted. The decision it
records names itself rather than borrowing `Manual review only`: its own reason
(`no_policy_configured`, which the SPA maps to its own copy) beside its own `presetName`. The two
refuse on the same rung of the merge ladder and need opposite remedies, so a reader sent to edit
the preset that held their PR back must not go looking for one they never had.

WHEN the fallback governs is a deployment-level fact, not a timing accident. A board's preset
library is written when the board is CREATED, so the only run it governs is one in a deployment
whose container wires no `riskPolicyRepository`. Seeding on the first `list()` instead would make
the answer depend on whether anybody had loaded the board first, and the public API starts runs on
boards no browser has ever opened: the same task merged or waited for a human depending on an
unrelated read, and the refusal named a posture nobody had chosen. `RiskPolicyService` still
repairs an empty library on read, which now only reaches a board created before that was true.

## Layer 5: agent text is untrusted on every rendered surface (mechanism)

Everything the agent writes that reaches a parsed surface is treated as hostile:

- PR bodies, descriptions and the verification report are scrubbed with `redactSecrets` **at
  compose time** (before truncation), capped, and passed through `hostMarkdown`, which neutralizes
  the host's auto-link triggers, so injected output cannot smuggle a `Closes #N` that deletes an
  issue on merge, break out of a fence to overwrite the machine-read report block, or echo a
  credential a subprocess error leaked into it.
- Captured command output shown back to a model is fenced with a fence sized longer than any
  backtick run in the body (`fencedOutput`), so tool output cannot spill into what the model reads
  as instructions.
- The report's **test environment lifecycle** section renders three families of hole a run does not
  control: a service-frame id and a provider's verbatim stderr from the deployer's per-frame
  outcomes, and the view name plus stored artifact id of every screenshot the tester captured.
  Every one crosses `hostMarkdown.cell`, and the provider error is scrubbed with `redactSecrets`
  first (a failing provisioner routinely echoes the request URL it was called with). The section's
  own prose is platform-authored constants, so the note and gap lines are deliberately NOT escaped:
  what a reader must be able to trust there is that no agent wrote them.
- Published review findings (`createReview`, on both providers) are a rendered surface too, and one
  that is **not** yet scrubbed: a finding's body is posted to the host verbatim. The exposure is
  bounded relative to a PR body: a host auto-links `#123`/`@name` in a comment, but only a
  DESCRIPTION or commit message can carry a closing keyword that acts on merge, and the findings a
  human selected in the review window are the only ones posted. It is listed here because "not a
  boundary" has to be written down to stay a decision rather than an oversight; folding these
  through `hostMarkdown` is the obvious next step and belongs on whichever half moves first, since
  the GitHub and GitLab posters must not diverge on it.
- Inbound tracker-comment commands are explicit first-token commands only, behind identity,
  data-not-instructions, and iteration-budget guards, and route through the same service methods
  the UI calls: there is no parallel webhook-driven mutation path into the engine.

## What is deliberately NOT a security boundary

Do not lean on any of these; the codebase explicitly refuses to:

- **`allowedTools` and agent instructions.** Tool allow-lists are scoping for focus, not
  containment (`custom-agents.md` states this outright). A "read-only" role is a prompt.
- **The merger's judgment**, or any other LLM verdict, for anything the preset and class rules
  don't floor. Judgments are defeatable by the same injection you're worried about.
- **Intra-container separation** between agent and harness (Layer 2's stated limit).
- **The sandboxed run mode (`dryRunRoles`) against someone who has repo write.** It refuses both of
  the PLATFORM's merge exits; it cannot stop a human merging the PR by hand on the host, and a PR is
  deliberately still opened. It is a real control in one specific shape: the engine falls back to
  the DEPLOYMENT credential for an initiator with no stored PAT, so an initiator who cannot merge
  on GitHub can still cause a merge by tapping the review card, and the mode closes that escalation.
  Against anyone holding write access on the host it is advisory. Branch protection, the first item
  on the hardening checklist below, is the mechanism; this is scoping on top of it.
- **The absence of a secret in the prompt.** Injected `.cat-context/` files and job bodies carry
  non-secret projections by design (`context.toolServers` never carries credential values; tool
  secrets ride the job body only, resolved by name through `ToolSecretResolver`), but anything the
  agent can read, assume it can also try to exfiltrate through text it writes, which is why
  Layer 5 scrubs at every exit.
- **The provenance of a wired MCP tool server.** A server's RESULTS are untrusted input like
  everything else the agent reads (the threat model above), so wiring one extends the set of
  parties who can attempt injection to that server's operator and its upstreams; and the run
  container applies no egress bound on which wired servers an already-subverted agent may call
  with what it has read, so a wired server is also a potential exfiltration channel.
  `allowedTools` does not contain this (first bullet). The controls that do exist are which
  servers a deployment wires for which kinds and the scope of the credential each is handed:
  see `mcp-tool-servers.md` → Security posture.

## Operator hardening checklist

**The checklist itself is on the website**, where the operators who act on it read it:
[Security Model & Hardening → Operator hardening checklist](https://www.catfactory.ai/reference/security-model.html#operator-hardening-checklist).
It is the same eight items in the same priority order, and it is maintained there.

What belongs here is the coupling a contributor has to keep true, because breaking it turns a
documented control into advice:

- **Items 1 and 2 (branch protection, merge presets) are the only two that decide whether malicious
  code can reach a default branch at all.** Anything on the write path that would let a run land a
  change without traversing both is a design error, not a feature.
- **Item 4 (govern stored personal PATs) is what makes item 3 (installation scope) bind.** The
  initiator's token outranks the App token on the standard dispatch path, so the account-level and
  workspace-level `allowInitiatorPat` switches are enforced mechanisms at BOTH tiers and every mint
  site routes through the one decision. A new mint site that reads the token directly silently
  removes the control.
- **The branch-protection preflight reports three states, never two.** A repo it could not reach is
  `unknown`, a protected branch whose rule was unreadable says so, and a provider that cannot answer
  reports `capability: 'unavailable'` rather than an empty list. It needs `integrations.manage`
  because it spends the installation's rate limit, which the CI gate and the merger draw on.

Changing any of those means updating the website page in the same PR, per the documentation sweep in
the root `CLAUDE.md`.

## Known gaps

- **On a hosted deployment, loopback local-model endpoints still reach the server itself.** With
  `LOCAL_MODELS_ALLOW_LAN` off, the remaining grant is `localhost` / `127.0.0.0/8` / `[::1]`,
  which is the intended target on a developer's own machine and pure downside on a shared one: a
  user's real Ollama is never on the hosted server's loopback, while in a container `127.0.0.1`
  reaches sibling processes, sidecars and the app's own port. Any signed-in user can drive it,
  because the connectivity probe takes a base URL straight from the request body and reports the
  upstream status, which makes it a loopback port prober. The fixed endpoint paths and the
  composed-URL rule bound WHAT can be requested, not WHETHER. The honest fix is a third state:
  the flag is a boolean where the vocabulary wants `off` / `loopback` / `lan`, so a hosted
  operator could disable the feature outright instead of narrowing it. Until then, treat the
  per-user local-runner feature as a single-tenant one.
- **Machine-token revocation binds at the handshake, not on an open socket.** Every
  `/internal/*` call and every subscribe handshake consults the tombstone, so a revoked node can
  open nothing new, but a WebSocket subscription opened before revocation keeps receiving that
  workspace's events until the socket drops. Severing it needs a revocation signal that reaches
  whichever replica or Durable Object holds the socket; tracked as SEC-12 in
  `docs/initiatives/security-hardening-round-2.md`.
- **Outside the reserved-key floor, what a capability credential may read from the deployment's
  environment is unbounded until an operator sets `allowKeys`.** `isReservedPlatformEnvKey` refuses
  the platform's own configuration with no configuration required and cannot be widened, but every
  other variable the deployment exports (`AWS_PROFILE`, a personal token, a vendor key belonging to
  something else) resolves for any tool server or generative integration that names it. The bound is
  `EnvToolSecretResolverOptions.allowKeys` and, like the account-level `allowInitiatorPat` floor, it
  ships UNSET: on a single-tenant deployment whose integrations are all its own, an allow-list is
  friction with nothing to buy. It binds for exactly the two cases Layer 2 names, a deployment
  installing third-party agent packages and a mothership-mode node, and for those it is the
  operator's to set. Storing the value in the per-workspace credential store instead keeps it off
  the environment path entirely, which is the narrower answer wherever it is available.
- **An initiator's personal PAT is still unbounded once it IS used.** The platform stores it sealed
  and never logs it, but it cannot narrow it: `repository_ids` scoping is an App-token mechanism
  with no PAT equivalent. What changed is that an account or a workspace can now decline to use it
  at all (`allowInitiatorPat`, an enforced mechanism at both tiers) and that its breadth is stated
  when a member tests or saves it. What has NOT changed: with the switch on, a member's classic
  token is exactly as wide as they made it, and the breadth report is advice at save time; it does
  not refuse the save, and it re-reads nothing later, so a token whose scopes are widened on GitHub
  afterwards is not re-flagged.

  **The structural fix is a GitHub App USER-TO-SERVER token, and it is not built.** "Cannot narrow
  it" is a property of the stored-PAT design, not a law: a user-to-server token obtained through
  the App's OAuth flow is bounded by the INTERSECTION of the installation's scope and the user's
  own access, and is short-lived. That is attribution (pushes and PRs from the human who started
  the run) with the operator's installation scoping still the real bound, which is exactly the
  property this whole section works around. `auth/GitHubOAuth.ts` already implements that flow,
  wired for LOGIN only (`scope: 'read:user'`, token read for identity and discarded), so what is
  missing is the run-path plumbing (consent per user, refresh, and a fallback for a repo the App
  is not installed on) rather than the client.

  It would not replace stored PATs. An individual adopter inside a non-adopting org has no App
  installation to obtain such a token against, so the PAT path stays: the two are for different
  deployments, and `allowInitiatorPat` remains how an operator chooses between them.

- **The branch-protection preflight is on demand and reports on the DEFAULT branch only.** It
  tells an operator where item 1 is missing, which is what nothing in-product used to do, but it
  is a check someone has to run, not a gate: no run is refused, and no notification is raised, for
  a repo whose default branch is unprotected. A release branch with its own weaker rule is out of
  its scope, and on a provider that cannot report protection (GitLab today) it answers
  `unavailable` rather than anything actionable.
- **Intra-container credential compartmentalization is best-effort** (Layer 2's stated limit). A
  hard fix (separate uid for the agent process, or a push executed outside the container entirely)
  is a container-image and transport change, not a policy change.
- **The merger reads attacker-influenced text** and there is no adversarial-input hardening beyond
  the computed-class floors and ceilings. Deployments that want defence-in-depth here should use
  class floors (configuration, available today) rather than waiting for prompt-level fixes.

If you change anything on the write path (token minting or credential PRECEDENCE, the push, the
merge decision, a rendered surface, or the native-child env allow-list) this document is part of the
change: keep the layer descriptions and the gap list truthful, in both directions. "In both
directions" is not a formality: this document has already been wrong by over-claiming a boundary
(Layer 4 read as unconditional) and by under-claiming one (the native env allow-list going
unmentioned), and each error misleads a different reader.
