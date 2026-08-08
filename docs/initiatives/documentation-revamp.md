# Documentation revamp: the repo ⇄ website split

Status: **proposal stage.** This PR lands the tracker only; no doc moves yet. The website's own
restructure is tracked by
[cat-factory-website#22](https://github.com/kibertoad/cat-factory-website/pull/22), which adds
`planning/documentation-revamp.md` there, and the two halves land coordinated slices (see the
checklist). That link names the open PR rather than the file it will add, because the first gotcha
below forbids linking a page that does not exist yet; the slice closing checklist item 0 swaps it
for the `blob/main` permalink.

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
the source path in the website repo.

| Topic                            | Repo doc                                                                                                                      | Website page                                     | Proposed authority                                                                                                                                     |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Custom agents                    | `backend/docs/custom-agents.md`, `custom-agent-roles.md`, `custom-agent-gate-ergonomics.md`                                   | `deploy/custom-agents.md`                        | Website owns authoring how-to; repo keeps engine design (registries, the three stages).                                                                |
| Public API                       | `backend/docs/public-api.md`                                                                                                  | `reference/public-api.md`                        | Website owns endpoint/scope/webhook usage; repo keeps the stability policy (ADR 0034) and the contracts → spec → SDK chain.                            |
| Model support                    | `backend/docs/model-support.md`                                                                                               | `guide/model-providers.md`                       | Website owns configuration and usage; repo keeps provisioning internals. Pilot slice.                                                                  |
| Runner pools                     | `backend/docs/runner-pool-integration.md`                                                                                     | `deploy/runner-pools.md`                         | Website owns operating a pool; repo keeps the integration protocol.                                                                                    |
| Environments                     | `backend/docs/environments-integration.md`, `local-k3s-environments.md`, `kubernetes-topology.md`                             | `deploy/environments.md`, `deploy/kubernetes.md` | Website owns setup and operation; repo keeps provider integration design.                                                                              |
| GitHub App                       | `backend/docs/github-integration.md`, `github-operations.md`                                                                  | `deploy/github-app.md`                           | Website owns setup and the operations runbook; repo keeps integration design.                                                                          |
| Environment variables            | `docs/environment-variables.md`                                                                                               | `deploy/configuration.md`                        | Website owns the operator-facing reference; the repo file stays as the canonical list its guard reads.                                                 |
| Glossary                         | `docs/glossary.md`                                                                                                            | `guide/core-concepts.md`                         | Website owns the product vocabulary; the repo glossary keeps the code-level naming map (dir ⇄ package names, internal seams).                          |
| Agent trust model                | `backend/docs/security-model.md`                                                                                              | `reference/agent-isolation.md`                   | Website owns the operator-facing account of what an adversarial agent can reach; repo keeps the full layer-by-layer boundary and the write-path rules. |
| Storage and retention            | `backend/docs/storage-and-retention.md`, `llm-telemetry.md`                                                                   | `deploy/observability.md`                        | Website owns retention windows and what is kept; repo keeps the table/rollup design.                                                                   |
| Repository layout                | root `README.md` tables                                                                                                       | `reference/packages.md`                          | Website owns the orientation map; the repo tables stay, pinned by `check-package-catalog.mjs`.                                                         |
| Repo-only, no website page today | `backend/docs/vcs-providers.md`, `backend/docs/debug-api.md`, `backend/docs/reports.md`, `sdk/README.md`, `sdk/mcp/README.md` | none                                             | Website gains the user-facing account (its tracker names the target section per doc); repo keeps internals where any remain.                           |

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

Each slice is a repo PR, a website PR, or a coordinated pair. Update with PR links as slices
land.

- [ ] 0. Trackers land: [#1847](https://github.com/kibertoad/cat-factory/pull/1847) and the
      website sibling
      [cat-factory-website#22](https://github.com/kibertoad/cat-factory-website/pull/22). On
      merge, repoint this tracker's header link at the website file's permalink.
- [ ] 1. Classify every doc under `backend/docs/` and `docs/` as contributor / user-facing /
      mixed, checking each against the site's navigation before recording "no website page";
      record the outcome as a table in this tracker.
- [ ] 2. Pilot: model support (website absorbs usage; repo doc reduced to internals plus
      link).
- [ ] 3. Environment variables: reconcile `docs/environment-variables.md` with the existing
      `deploy/configuration.md`, which already documents most of the set. The repo file stays: it
      is the list `check-reserved-env-keys.mjs` reads, and that guard only works in the repo whose
      PRs add variables (see the gotcha). This slice decides how the site stops drifting from it,
      generation from the repo file being the obvious candidate.
- [ ] 4. Agent trust model: reconcile `backend/docs/security-model.md` with the existing
      `reference/agent-isolation.md`, which already carries the operator-facing account; the repo
      doc keeps the full layer-by-layer boundary and drops what the page now owns.
- [ ] 5. Glossary: reconcile `docs/glossary.md` with the existing `guide/core-concepts.md`, which
      already defines the product vocabulary; the repo glossary keeps the code-level naming map.
- [ ] 6. Storage and retention: reconcile `backend/docs/storage-and-retention.md` and
      `llm-telemetry.md` with the existing `deploy/observability.md`; repo keeps the sink/rollup
      design.
- [ ] 7. SDKs and MCP: user docs to the website's extender section; `sdk/*/README.md` keep
      their package-shipped content self-contained. Reducing `sdk/README.md` to a pointer breaks
      three inbound links from shipped `README`s, so they move in this slice (see the gotcha).
- [ ] 8. Custom agents, gates, providers, frontend extensions: website owns authoring; repo
      docs reduced to engine design plus links.
- [ ] 9. VCS: GitHub App setup and operations to the website; the GitHub/GitLab support
      matrix (`vcs-providers.md`) to the website; repo keeps integration design.
- [ ] 10. Root README: shrink the Feature guide and Documentation index to the split model;
      each user-facing row links the website section. The repository-layout tables stay as they
      are, pinned by `check-package-catalog.mjs` (see the gotcha).
- [ ] 11. State the model: `docs/README.md` and `CONTRIBUTING.md` gain the "where does a new
      doc go" rule; CLAUDE.md's staleness sweep gains the website question (rule 5 above).

## Gotchas

- **Land the website page before the repo link to it.** A repo doc linking a 404 fails
  silently for every reader. This tracker's header obeys its own rule: it links the open website
  PR, not the file that PR adds.
- **The website restructure changes URLs.** Its tracker's phase A regroups navigation without
  moving files precisely so slices here can start early; slices that link moved pages wait
  for the website's redirect slice, or link section anchors that survive the move.
- **`check-shipped-doc-links.mjs` checks BOTH directions of a shipped doc's links.** A published
  package `README` may not link a repo-relative path outside its own package, so website links
  from one must be absolute URLs. And a repo-absolute
  `https://github.com/kibertoad/cat-factory/blob/main/...` link is resolved against this checkout,
  so DELETING OR RENAMING a linked repo doc reds CI in the slice that does it. Inbound links from
  shipped `README`s today: `backend/docs/public-api.md` 4, `sdk/README.md` 3,
  `backend/docs/reusable-operations.md` 2, `backend/docs/custom-agents.md` and
  `backend/docs/model-support.md` 1 each, with `public-api.md` and `sdk/README.md` each carrying one
  anchored link. A slice reducing one of those to a pointer keeps the anchors it names, or repoints
  the inbound links in the same PR.
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
