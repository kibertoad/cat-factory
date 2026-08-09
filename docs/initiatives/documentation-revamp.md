# Documentation revamp: the repo ⇄ website split

Status: **executing.** The website's side is complete (its phases A through D) and the repo-side
slices below are done except where the checklist says otherwise: what remains is item 15's two
outstanding reductions and item 12's deferred endpoint reference. The sibling tracker is
[`planning/documentation-revamp.md`](https://github.com/kibertoad/cat-factory-website/blob/main/planning/documentation-revamp.md)
in the website repo, which holds the section structure and the research behind it.

## Goal and rationale

The platform has two documentation surfaces: this repo (the root `README.md`, `backend/docs/`,
`docs/`, package `README`s, `sdk/`) and the product site
[catfactory.ai](https://www.catfactory.ai/) (repo
[kibertoad/cat-factory-website](https://github.com/kibertoad/cat-factory-website)). No stated
rule decides which surface owns a topic, so three problems have accumulated:

- **Most large topics are documented twice**, once per surface, each pair drifting independently:
  custom agents, the public API, model support, runner pools, ephemeral environments, the GitHub
  App, environment variables, the glossary, the agent trust model, storage and retention, and the
  repository layout. The audit below pairs each with its live website page.
- **Some user-facing material is repo-only.** `backend/docs/vcs-providers.md`,
  `backend/docs/debug-api.md`, `backend/docs/reports.md`, `sdk/README.md` and `sdk/mcp/README.md`
  serve integrators and operators, none of whom should need a checkout to read them, and the site's
  navigation carries no page for any of them.
- **The root README restates the website.** Its Feature guide and parts of the Documentation
  index duplicate the site's guide section instead of pointing at it.

The revamp is one conceptual model that assigns every doc a home, executed incrementally with
a per-slice checklist.

## The conceptual model

Ownership follows the READER, not the topic.

- **The website is for people who run and use the product**: deployers, operators, workspace
  users, and integrators building on the public surface (API, SDKs, MCP, manifests). The
  test: the reader can act on the page without cloning this repo.
- **The repo is for people who change the code**: flow docs, ADRs, initiative trackers,
  `AGENTS.md` maps, package `README`s, the CI/test/release process, `CLAUDE.md`. The test:
  the doc is updated in the same PR as the code it describes, or it describes this
  repository's own process.

This is the standard split among mature projects. React keeps react.dev as the product docs
while facebook/react holds only contributor material; Kubernetes splits kubernetes.io from
kubernetes/kubernetes, with contributor docs in kubernetes/community; Node.js, Vue and Vite
publish user docs on their sites and keep the repo for contributors. The section-structure
research (Diátaxis, the Kubernetes/GitLab/Stripe navigation models) lives in the website
tracker, which applies it.

Five rules follow:

1. **One authority per topic.** Where a topic serves both audiences, split by DEPTH, never by
   copy: the website page owns the user-facing account, and the repo doc keeps only the
   internal design plus a link to the website page for usage. Two parallel full accounts is
   the failure mode this model exists to end.
2. **A repo gap links the website section.** Where a repo doc needs user-level context (how a
   feature is operated, what a screen shows), it links the relevant website section instead
   of restating it. The root README's Cookbook entry ("product docs, task-indexed rather than
   architecture-indexed") already does this; it is the model to copy.
3. **A website gap is filled by moving, never mirroring.** Where the website lacks material
   that exists here, the user-facing content moves there and the repo keeps a pointer plus
   whatever internal depth remains.
4. **Named exceptions stay in the repo regardless of audience**:
   - package `README`s that ship in published tarballs (`check-shipped-doc-links.mjs` bans
     out-of-package links, so they stay self-contained; they may link the website by absolute
     URL);
   - generated reference (`docs/openapi.json`) that the site renders or links rather than
     recreates;
   - GitHub-native surfaces: `CONTRIBUTING.md`, and the README quickstart kept short with the
     site as the long version;
   - **a doc a CI guard reads**, which stays where the guard runs (see the
     `check-reserved-env-keys.mjs` and `check-package-catalog.mjs` gotchas): the guard's value is
     that it fires in the PR that changes the code, so the doc has to live in that PR's repo.
5. **The staleness sweep covers the website.** The per-PR documentation sweep (CLAUDE.md)
   gains one question: does this change alter behaviour a website page describes? If yes, the
   PR says so, and the website repo's `sync-docs` pass (which reads this repo's commit
   history) picks it up.

## Current duplication and misplacement

The audit so far, checked against the site's live navigation on 2026-08-08 and to be completed by
slice 1. **Assume the website already covers a topic until its navigation says otherwise**: the
first draft of this table recorded "none" for four topics the site already documents, which scoped
their slices as moves into a gap rather than as the reconciliations they are. Website cells name
the source path in the website repo, **re-checked after that repo's phases C and D**, which moved
the extension pages under `extend/` and the operating pages under `operate/` and split two pages in
half. A cell here is the first thing the next slice reads, so a path left at where the page used to
be is the rot this table exists to prevent.

| Topic                            | Repo doc                                                                                                                      | Website page                                                    | Proposed authority                                                                                                                                     |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Custom agents                    | `backend/docs/custom-agents.md`, `custom-agent-roles.md`, `custom-agent-gate-ergonomics.md`                                   | `extend/custom-agents.md`, `extend/custom-gates.md`             | Website owns authoring how-to; repo keeps engine design (registries, the three stages).                                                                |
| Public API                       | `backend/docs/public-api.md`                                                                                                  | `extend/public-api.md`                                          | Website owns endpoint/scope/webhook usage; repo keeps the stability policy (ADR 0034) and the contracts → spec → SDK chain.                            |
| Model support                    | `backend/docs/model-support.md`                                                                                               | `guide/model-providers.md`                                      | Website owns configuration and usage; repo keeps provisioning internals. Pilot slice.                                                                  |
| Runner pools                     | `backend/docs/runner-pool-integration.md`                                                                                     | `operate/runner-pools.md`                                       | Website owns operating a pool; repo keeps the integration protocol.                                                                                    |
| Environments                     | `backend/docs/environments-integration.md`, `local-k3s-environments.md`, `kubernetes-topology.md`                             | `operate/environments.md`, `deploy/kubernetes.md`               | Website owns setup and operation; repo keeps provider integration design.                                                                              |
| GitHub App                       | `backend/docs/github-integration.md`, `github-operations.md`                                                                  | `deploy/github-app.md`                                          | Website owns setup and the operations runbook; repo keeps integration design.                                                                          |
| Environment variables            | `docs/environment-variables.md`                                                                                               | `deploy/configuration.md`                                       | Website owns the operator-facing reference; the repo file stays as the canonical list its guard reads.                                                 |
| Glossary                         | `docs/glossary.md`                                                                                                            | `reference/glossary.md`, `guide/core-concepts.md`               | Website owns the product vocabulary; the repo glossary keeps the code-level naming map (dir ⇄ package names, internal seams).                          |
| Agent trust model                | `backend/docs/security-model.md`                                                                                              | `reference/agent-isolation.md`, `reference/security-model.md`   | Website owns the operator-facing account of what an adversarial agent can reach; repo keeps the full layer-by-layer boundary and the write-path rules. |
| Storage and retention            | `backend/docs/storage-and-retention.md`, `llm-telemetry.md`                                                                   | `operate/observability.md`, `operate/upgrades-and-retention.md` | Website owns retention windows and what is kept; repo keeps the table/rollup design.                                                                   |
| Repository layout                | root `README.md` tables                                                                                                       | `reference/packages.md`                                         | Website owns the orientation map; the repo tables stay, pinned by `check-package-catalog.mjs`.                                                         |
| Repo-only, no website page today | `backend/docs/vcs-providers.md`, `backend/docs/debug-api.md`, `backend/docs/reports.md`, `sdk/README.md`, `sdk/mcp/README.md` | none                                                            | Website gains the user-facing account (its tracker names the target section per doc); repo keeps internals where any remain.                           |

## Classification (slice 1)

Every doc under `backend/docs/` and `docs/`, classified by READER. "Mixed" means the topic serves
both audiences and is split by depth: the website page owns the user-facing account and the doc here
keeps the internal design plus a link.

Rather than one row per file, whole categories classify together and only the exceptions are named,
because a per-file table of 160 rows rots faster than the docs it describes.

| Category                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Classification       | Rule                                                                                                                                                                                                  |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `backend/docs/adr/*` (50 files)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | contributor          | A decision record is written for whoever changes the code next. None moves.                                                                                                                           |
| `docs/initiatives/*` (64 files)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | contributor          | Describes a target state that may be partly built. Never a user-facing source.                                                                                                                        |
| `docs/internal/*`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | contributor          | This repository's own process.                                                                                                                                                                        |
| Engine flow docs: `agent-prompt-overrides`, `bug-hunt`, `bug-triage-pipeline`, `concurrency-and-redis`, `consensus-panels`, `container-reaping`, `env-lifecycle`, `execution-state-machine`, `gitlab-parity`, `individual-subscription-usage`, `infrastructure-providers-window`, `logging`, `per-service-provisioning`, `pipeline-catalog-lifecycle`, `pipeline-pr-descriptions`, `prompt-caching`, `ralph-loop`, `requirements-review`, `review-debt-friction`, `service-connections`, `visual-confirmation`                   | contributor          | Each describes a seam, an invariant or a flow the code implements. The product behaviour they produce is described on the website by the page that owns that feature, and none of these is that page. |
| `model-support`, `security-model`, `storage-and-retention`, `llm-telemetry`, `custom-agents`, `custom-agent-roles`, `custom-agent-gate-ergonomics`, `mcp-tool-servers`, `custom-binary-stores`, `github-integration`, `github-operations`, `vcs-providers`, `environments-integration`, `local-k3s-environments`, `native-environment-adapter`, `kubernetes-topology`, `runner-pool-integration`, `document-sources`, `auth`, `reports`, `debug-api`, `reusable-operations`, `initiative-presets`, `figma-claude-design-context` | mixed                | Split by depth. Each now OPENS with a pointer naming the website page that owns the user-facing account; the reduction itself has run only where checklist item 15 says so.                           |
| `docs/environment-variables.md`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | user-facing, stays   | A CI guard reads it. The website RENDERS it.                                                                                                                                                          |
| `docs/glossary.md`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | contributor          | Code-level naming map; the product vocabulary is the website's glossary.                                                                                                                              |
| `docs/README.md`, `CONTRIBUTING.md`, `CLAUDE.md`, `AGENTS.md`                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | contributor          | This repository's own orientation and process.                                                                                                                                                        |
| `backend/docs/public-api.md`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | mixed, deferred      | See checklist item 12.                                                                                                                                                                                |
| `backend/docs/local-kubernetes-setup-windows.md`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | user-facing, unmoved | A platform-specific setup recipe with no website home yet. Candidate for the Deploy section; not worth a page of its own until the Kubernetes page needs it.                                          |
| `sdk/README.md`, `sdk/mcp/README.md`, `sdk/*/README.md`, `backend/packages/*/README.md`, `deploy/*/README.md`                                                                                                                                                                                                                                                                                                                                                                                                                    | named exception      | A README that ships in a published tarball stays self-contained and links the website by absolute URL.                                                                                                |
| `docs/openapi.json`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | named exception      | Generated. The site links or renders it, never recreates it.                                                                                                                                          |

Two classifications changed as the slices ran, and both are recorded because the reasoning is not
obvious from the file:

- **`gitlab-parity.md` is contributor**, even though the support matrix it feeds is user-facing. The
  matrix says what a user gets; the parity log says which gaps are deliberate and which are pinned
  by a conformance suite, which only means something with the code open.
- **`github-operations.md` is mixed rather than user-facing.** Setup moved, but the failure
  signatures and the token plumbing are read with the repository open.

## Target pattern (the pilot)

Pilot topic: **model support**, because the pair is large, actively edited, and cleanly
splittable.

- `guide/model-providers.md` on the website absorbs everything user-facing that today only
  `backend/docs/model-support.md` states.
- `backend/docs/model-support.md` drops the usage sections, keeps the
  provisioning/composition internals, and opens with a link to the website page.
- The root README's Documentation index entry keeps pointing at the repo doc, renamed to say
  it is internals.

The pilot establishes the reusable mechanics: the link phrasing, how much depth stays behind,
and the landing order (website PR first, so the repo link never 404s).

## Checklist

Each slice is a repo PR, a website PR, or a coordinated pair. Update with PR links as slices land.

- [x] 0. Trackers land: [#1847](https://github.com/kibertoad/cat-factory/pull/1847) and the website
      sibling [cat-factory-website#22](https://github.com/kibertoad/cat-factory-website/pull/22).
      This tracker's header now links the website file's permalink rather than its PR.
- [x] 1. Classify every doc under `backend/docs/` and `docs/` (see the classification below).
- [x] 2. Pilot: model support. The website absorbed usage; the repo doc opens with the pointer and
      keeps resolution, precedence, harness and provisioning internals. **Section numbering is
      load-bearing**: `agents/src/providers/docs.ts` links `#8-provisioning-per-runtime` and
      `#aws-bedrock-opt-in` from runtime error messages, so sections may be reduced but not
      renumbered.
- [x] 3. Environment variables. The repo file stays canonical (`check-reserved-env-keys.mjs` reads
      it) and the website page is GENERATED from it by the site's `scripts/sync-env-vars.mjs`, with
      `--check` failing on staleness. Two variables the code reads were documented nowhere
      (`NOTIFICATION_RETENTION_DAYS`, `PROVISIONING_LOG_RETENTION_DAYS`): documenting them required
      reserving them, so `reserved-env-keys.ts` gained both as exact names.
- [x] 4. Agent trust model. The website gained a security-model page (layer taxonomy, the
      non-boundaries, the hardening checklist, the known gaps) beside agent-isolation; the repo doc
      keeps the layer-by-layer mechanism and the couplings a contributor must not break.
- [x] 5. Glossary. The website gained a product glossary; the repo glossary states that it is the
      code-level naming map and what belongs where.
- [x] 6. Storage and retention. The website's upgrades-and-retention page owns the windows and the
      upgrade path; the repo docs keep the sink and rollup design. The site's observability page
      claimed a 3-day telemetry default the code had moved to 14; fixed.
- [x] 7. SDKs and MCP. Two website pages (SDKs, MCP server); `sdk/README.md` reduced to the
      generation chain, the smoketest and releases. The four shipped clients' anchored links to its
      "pointing at localhost" section were repointed at the website page in the same change, per the
      gotcha below.
- [x] 8. Custom agents, gates, providers, frontend extensions. Website owns authoring and the repo
      docs open with the pointer. The reduction `custom-agents.md` still owed landed under item 15a.
      `custom-binary-stores.md` (added after this tracker was written) landed its user-facing half
      on the website's custom-providers page as a third code seam.
- [x] 9. VCS. The support matrix moved to the website; `vcs-providers.md` is now the provider-layer
      map plus the two facts that bite a change, and `gitlab-parity.md` stays the accepted-gap log.
- [x] 10. Root README: the Feature guide is a "using it / how it is built" table, and the
      Documentation index states the ownership model.
- [x] 11. State the model: `docs/README.md` and `CONTRIBUTING.md` gained "Where does a new doc go?",
      and CLAUDE.md's staleness sweep gained the website question (paid for inside the file's size
      budget, not by raising it).
- [ ] 12. **The `/api/v1` endpoint reference stays in the repo, deliberately deferred.**
      `public-api.md` is 2000 lines of prose companion to the generated `docs/openapi.json`, and
      several of its anchors are linked from published package READMEs and from error messages in
      code. The website owns the integrator's first read; moving the reference itself needs its own
      slice, with the anchor inventory done first.
- [x] 14. Enforce the coupling slice 9 broke silently. `scripts/check-doc-anchors.mjs` resolves
      every doc URL built in code to a file AND a heading, across all THREE modules that build them
      (`config/docs.ts`, `vcs-errors.ts`, `providers/docs.ts`: each layer sits below the last and
      cannot import it). Deliberately NOT guarded: whether a catfactory.ai link resolves. That needs
      either the network, which fails on the website's outages rather than on our mistakes, or a
      checked-in copy of the site's page list, which is a second routing table to keep in step and
      rots in the direction that matters most, since a page deleted from the site would stay listed
      and keep passing.
- [ ] 15. **Finish the reductions the pointers only announced.** A pointer at the top of a doc is
      not the split; it is the promise of one, and on a checklist the promise reads as done. Slices
      2 to 11 reduced five things: `sdk/README.md` (-92 lines), `security-model.md` (-60),
      `vcs-providers.md` (-24), the root `README.md` (-13) and `model-support.md` §6-§8. Every other
      doc in the "mixed" row gained a pointer over unchanged prose, which is the two-parallel-full-
      accounts state rule 1 exists to end. One doc per PR, each section checked against the LIVE
      page before it is cut. **15a has landed; 15b and 15c are what keeps this item open.**

      **Trap that shapes all three: the site splits a feature from its MANIFEST.** A manifest schema
                  lives on `extend/manifests.html`, not on the feature's own page, so a repo doc reducing its
                  manifest section points THERE. Reducing it toward the feature page instead loses the schema
                  for every reader.

                  **15a. `custom-agents.md`: DONE (553 → 326 lines).** Every section was checked against the
                  live page before it was cut, and the plan held except where the last column says otherwise.

                  | Section                             | Disposition                                                                                             |
                  | ----------------------------------- | ------------------------------------------------------------------------------------------------------- |
                  | The governing principle             | KEPT. "Zero `switch(agentKind)` in the container" is an invariant a contributor breaks, not a how-to.   |
                  | The three stages                    | CUT to the stage names plus the `RepoFiles` source link, pointing at the site's "The mental model".     |
                  | The seams                           | CUT: the registration example and the `AgentKindDefinition` table are both on the site, and the site's table is the LONGER one (`tuning`, `gatable`, `fanOutMultiRepo`). Kept the `standardsDelivery: 'context-files'` rationale and `registeredKindRequiresContainer`. |
                  | Variations of an EXISTING kind      | KEPT. The site has four sentences; these lines are WHY a variant is not a kind, which is the safety property. |
                  | Capabilities → Skills               | KEPT. Deeper than the site: the three ref forms, bundled vs catalog resolution, harness-aware install, the overlap with the built-in `skill` KIND. Cut only the registration snippet the site carries. |
                  | Capabilities → Tool servers (MCP)   | CUT to one paragraph naming `mcp-tool-servers.md` as the authority. The four "altitude" bullets it kept were four facts that doc states in full.  |
                  | Capabilities → Binary generators    | CUT to the two-registries split (storage is a selected foundational service, generation is the deployment's own registry) plus the link. Verified: `binary-output-foundational-storage.md` owns every other line of it. |
                  | Judges                              | CUT to why it is the fourth bucket and why neither other seam fits, with the registration on the site and the design (D9's model-pin precedence included) in `judge-registry.md`. |
                  | The worked example                  | CUT to one paragraph naming what `backend/internal/example-custom-agent` registers, which is the executable copy. |
                  | Status / scope                      | KEPT.                                                                                                    |

                  Two couplings the cut had to carry, both invisible from the page itself:
                  `agent-prompt-overrides.md` deep-links `#variations-of-an-existing-kind-alternate-prompts-programmatically`
                  and `custom-agent-roles.md` deep-links `#capabilities-skills-and-tools`, so both headings are
                  load-bearing and stay. `custom-agent-roles.md` also pointed AT the `AgentKindDefinition` table
                  this slice deleted; it now points at the section that survived, in the same change.

                  15b. `environments-integration.md` (442 lines). The site is BIGGER here (18 sections), so the
                  repo doc is the junior partner: `## The manifest` (152) belongs to
                  `extend/manifests.html#environment-provider-manifest`; `## Code-adapter seam` (126) is the one
                  to keep, being a code seam, but the site's `#when-the-manifest-isn-t-enough` covers the
                  choosing half; `## How it works` (18) and `## Registering a provider` (19) are on the site
                  verbatim. `## Reaching an internal / VPN-hosted platform`, `## Provisioning & discovery` and
                  `## Security notes` stay.

                  15c. `runner-pool-integration.md` (701 lines) is the MILD case and the one most likely to be
                  over-cut. `operate/runner-pools.html` has four sections; almost everything here is genuinely
                  deeper. Exactly one section duplicates: `## 3. Describe your scheduler as a manifest` (203),
                  which `extend/manifests.html#runner-pool-manifest` owns. The runner image and job protocol
                  (117), the k3s/Nomad mapping (48), the trust boundary (41) and scaling (25) all stay.

                  `llm-telemetry.md` is the model of a clean split and needs nothing: every section is an
                  internal rule with no counterpart on the site. Copy its shape.

- [x] 13. The website's page-quality pass (its phase D) landed in
      [cat-factory-website#24](https://github.com/kibertoad/cat-factory-website/pull/24): the
      opening/closing shape on the pages that predate the revamp, task-oriented titles on the how-to
      pages (reference pages deliberately keep noun titles), and both oversized pages split. The
      split that matters here is `extend/custom-agents.md`, which shed gates, step-completion
      resolvers and judges to `extend/custom-gates.html`, so a repo doc reducing a JUDGE section
      points at that page rather than the agents one.

## Docs added since this tracker was written

Checked against `main` on 2026-08-08, after the tracker's base commit:

| Doc                                                         | Classification | Outcome                                                                                                                                                                                                      |
| ----------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `backend/docs/custom-binary-stores.md`                      | mixed          | User-facing half (what you implement, how a store is selected, what it owes the sweeps) added to the website's custom-providers page as the third code seam; repo doc keeps the cache and resolution design. |
| `backend/docs/adr/0050-public-api-headless-completeness.md` | contributor    | Stays. An ADR is a decision record by definition.                                                                                                                                                            |
| `backend/internal/conformance/README.md`                    | contributor    | Stays. It describes this repository's own test suite.                                                                                                                                                        |

## Repo-to-repo duplication, found while planning slice 15

The audit classified every doc by READER and asked, per doc, what the website should own. It never
asked what a SIBLING doc already owns, so this class was invisible to it: two repo docs, same
audience, same material, neither aware the other is authoritative. It is the same failure mode as
the website duplication (rule 1's "two parallel full accounts"), and it is not fixed by the split,
because moving the user-facing half to the site leaves both copies of the internal half behind.

Recorded here, deliberately NOT fixed in the execution PR: each needs its own judgement about which
doc is the authority, and folding that into a website slice would hide it. All three were in
`custom-agents.md` and all three were resolved by slice 15a, which is why the judgement is recorded
per row rather than left to the next reader.

| Restated in                                     | Already owned by                                         | Judgement                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `custom-agents.md` → "Tool servers (MCP)"       | `mcp-tool-servers.md`                                    | Resolved: that doc is the authority and `custom-agents.md` now only says a tool server resolves in the container EXECUTOR rather than the engine, which is the one fact placing it in THIS doc's model.                                                                                                                                                                                 |
| `custom-agents.md` → "Judges"                   | `docs/initiatives/judge-registry.md`                     | Resolved toward the live tracker, NOT deferred behind its ADR conversion: that conversion is due when the tracker's own slice 12 lands, and blocking a documentation slice on an unrelated engine slice would leave the duplicate standing meanwhile. The link moves to the ADR when the tracker converts, which is one edit `check-shipped-doc-links.mjs` would red if it were missed. |
| `custom-agents.md` → "Binary-output generators" | `docs/initiatives/binary-output-foundational-storage.md` | Verified before cutting, and the shape WAS the same: the initiative doc states the brief, the closed content-type vocabulary, both admission refusals and the credential rule at greater depth than the section restating them.                                                                                                                                                         |

**The rule this suggests, and it held on the second pass:** a doc that names another as "the full
model" may not also contain that model. Say what the reader needs to decide whether to follow the
link (one paragraph), and link. `custom-agents.md` broke it three times in one file, each time
inside a section that opened by naming the authority.

**And the corollary 15a added: pointing at a live TRACKER is allowed.** A tracker is contributor
material by classification and converts to an ADR on its own schedule, so making a doc wait for
that conversion just keeps a duplicate alive. Point at the tracker and move the link when it
converts.

## Gotchas

- **Land the website page before the repo link to it.** A repo doc linking a 404 fails
  silently for every reader. This tracker's header obeys its own rule: it links the open website
  PR, not the file that PR adds.
- **The website restructure changes URLs.** Its tracker's phase A regroups navigation without
  moving files precisely so slices here can start early; slices that link moved pages wait
  for the website's redirect slice, or link section anchors that survive the move.
- **Landing the website page FIRST is the ordering rule, and the generated env page is the one
  exception**: it is rendered from the repo file, so the repo edit comes first and the site's
  `sync-env-vars.mjs` run comes second, in the website PR.
- **`check-shipped-doc-links.mjs` checks BOTH directions of a shipped doc's links.** A published
  package `README` may not link a repo-relative path outside its own package, so website links
  from one must be absolute URLs. And a repo-absolute
  `https://github.com/kibertoad/cat-factory/blob/main/...` link is resolved against this checkout,
  so DELETING OR RENAMING a linked repo doc reds CI in the slice that does it. Inbound links from
  shipped `README`s today: `backend/docs/public-api.md` 4, `sdk/README.md` 3,
  `backend/docs/reusable-operations.md` 2, `backend/docs/custom-agents.md` and
  `backend/docs/model-support.md` 1 each, with `public-api.md` and `sdk/README.md` each carrying one
  anchored link. A slice reducing one of those to a pointer keeps the anchors it names, or repoints
  the inbound links in the same PR. Slice 7 took the second route for `#pointing-an-sdk-at-localhost-or-a-mock`
  and slice 2 took the first, because `model-support.md`'s anchors are linked from RUNTIME ERROR
  MESSAGES (`agents/src/providers/docs.ts`), where a stale link reaches an operator with no way back.
- **An anchor linked from CODE is a different coupling from one linked in markdown, and slice 9
  broke it.** Reducing `vcs-providers.md` deleted `## Setup`, which the GitLab webhook-rejection
  warning deep-linked as `DOCS.vcsProviders('setup')`: an operator following it from the logs landed
  on a page with no setup section, in the same commit that removed the `GITLAB_WEBHOOK_SECRET`
  content they were sent for. `signatureLog.test.ts` asserted the message contains
  `vcs-providers.md#setup` and passed throughout, because a test on a composed string cannot see
  whether the heading exists. The fix is the general one, not a restored heading: setup now belongs
  to the website, so the remedy names the page that owns it (`SITE_DOCS.vcsSetup`), and
  `check-doc-anchors.mjs` resolves every such target. **Before reducing a doc, grep `config/docs.ts`,
  `vcs-errors.ts` and `providers/docs.ts` for it**; a remedy whose instruction the website now owns moves to `SITE_DOCS`,
  and one about this repo's internals keeps its heading.
- **The ordering rule cuts both ways across two repositories.** "Land the website page FIRST" is
  right, but the two repos merge independently and neither CI can see the other, so a link is not
  self-evidently correct at review time and a reviewer cannot be asked to hold the site's deploy
  state in their head. There is no guard for this and a checked-in page list was tried and rejected
  (item 14 says why), so it stays a human step: LOAD the page before you link it, and say in the PR
  that you did.
- **`check-reserved-env-keys.mjs` is a SAME-REPO coupling, not a file-path one.** It reads
  `docs/environment-variables.md` and fails when a documented variable is missing from the reserved
  set, and its whole value is that this fires in the PR that adds the variable: the documentation
  sweep already requires the row, so the reserved set cannot rot unnoticed. With the prose on the
  website, a newly added `SOMETHING_URL` is documented in a repo whose CI never sees it, stays
  nameable as a capability credential, and its value is read off the deployment environment into a
  prompt-injectable agent process. So the canonical list stays here; re-pointing the guard at the
  website is not an option slice 3 may take.
- **`check-package-catalog.mjs` pins every package name into the root README's layout tables.**
  The repository-layout pair is therefore the one duplicate that cannot be resolved by deletion:
  slice 10 may shrink the prose around the tables, but the rows themselves stay, and
  `reference/packages.md` remains a second copy kept in step by the site's `sync-docs` pass.
- **The website's `sync-docs` skill reads this repo's commit history.** A commit that removes
  or relocates a repo doc should say where the content went, so the sync pass re-links
  instead of re-importing deleted material.
