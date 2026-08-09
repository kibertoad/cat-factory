# ADR 0051: Documentation ownership follows the reader, split by depth across two repositories

- **Status:** Accepted (implemented)
- **Date:** 2026-08-09
- **Context layer:** every documentation surface this repository holds (root `README.md`,
  `backend/docs/`, `docs/`, package `README`s, `sdk/`) plus the product site
  [catfactory.ai](https://www.catfactory.ai/), whose source is
  [kibertoad/cat-factory-website](https://github.com/kibertoad/cat-factory-website)

Supersedes the `documentation-revamp` initiative tracker, whose committed scope is complete: 23
items, of which the last re-derived the audit's own open cell and closed it. The site's sibling
tracker stays under `planning/` in that repository as the record of why the navigation is shaped
the way it is. This record keeps the ownership rule, the decisions taken against alternatives, and
the findings the execution produced that no rule could have predicted.

## Context

The platform documents itself twice. This repository carries the root `README`, `backend/docs/`,
`docs/`, package `README`s and `sdk/`; catfactory.ai carries the product site. No stated rule
decided which surface owned a topic, and three problems had accumulated.

**Most large topics were documented twice, each pair drifting independently**: custom agents, the
public API, model support, runner pools, ephemeral environments, the GitHub App, environment
variables, the glossary, the agent trust model, storage and retention, the repository layout. Two
parallel full accounts with a link between them, neither authoritative.

**Some user-facing material was repo-only.** `vcs-providers.md`, `debug-api.md`, `reports.md`,
`sdk/README.md`, `sdk/mcp/README.md`, `auth.md`, `reusable-operations.md` and
`figma-claude-design-context.md` served integrators and operators, none of whom should need a
checkout. The sharpest case: the site named three sign-in providers and never mentioned OIDC, so
the only trace of enterprise SSO anywhere a deployer could read was a generated environment-variable
row linking back into this repository.

**The root README restated the website**, duplicating the site's guide section rather than pointing
at it.

## Decision

**Ownership follows the READER, not the topic.**

- **The website is for people who run and use the product**: deployers, operators, workspace users,
  integrators building on the public surface. The test: the reader can act on the page without
  cloning this repository.
- **This repository is for people who change the code**: flow docs, ADRs, initiative trackers,
  `AGENTS.md` maps, package `README`s, the CI/test/release process, `CLAUDE.md`. The test: the doc
  is updated in the same pull request as the code it describes, or it describes this repository's
  own process.

Five rules follow, and they bind every future documentation change:

1. **One authority per topic.** Where a topic serves both audiences, split by DEPTH, never by copy:
   the website page owns the user-facing account and the doc here keeps the internal design plus a
   link. Two parallel full accounts is the failure mode this model exists to end.
2. **A repo gap links the website section** rather than restating it.
3. **A website gap is filled by MOVING, never mirroring.** The user-facing content goes there and
   this repository keeps a pointer plus whatever internal depth remains.
4. **Named exceptions stay here regardless of audience**: package `README`s that ship in published
   tarballs (`check-shipped-doc-links.mjs` bans out-of-package relative links, so they stay
   self-contained and may link the site only by absolute URL); generated reference
   (`docs/openapi.json`), which the site renders rather than recreates; GitHub-native surfaces
   (`CONTRIBUTING.md`, the README quickstart); and **a doc a CI guard reads**, which stays where
   the guard runs.
5. **The per-pull-request staleness sweep covers the website.** Does this change alter behaviour a
   website page describes? If yes, the website pull request is opened and merged FIRST and named in
   this one's description.

**Two topics are deliberately DUPLICATED, and both are pinned by a guard rather than by care.**
`docs/environment-variables.md` stays canonical here because `check-reserved-env-keys.mjs` reads it,
and the site GENERATES its reference page from it (`sync-env-vars.mjs`). The root README's layout
tables stay because `check-package-catalog.mjs` pins every package name into them, so
`reference/packages.md` is a second copy kept in step by the site's `sync-docs` pass. In both cases
the guard firing in the pull request that changes the code is the whole value, which is what a
same-repo coupling buys and a cross-repo one cannot.

**The `/api/v1` reference is RENDERED, never moved.** The complete, always-current endpoint
reference is the spec; `sync-openapi.mjs` emits `extend/api-reference.md` from `docs/openapi.json`,
and the generator asserts what makes the output a reference rather than a dump (every operation
states a minimum scope, summaries are unique because they become anchors, every operation carries
exactly one tag because the grouping is the navigation, no two headings slug the same). What stayed
in `public-api.md` is what the spec cannot express: the refusal vocabularies behind each `4XX`, the
caps, the ordering rules and the worked walkthroughs. Fixing the spec to declare its refusal codes
per operation would change that answer, and is a public-API change rather than a documentation one.

## Rationale

**The split is the standard one among mature projects.** React keeps react.dev as the product docs
while facebook/react holds contributor material; Kubernetes splits kubernetes.io from
kubernetes/kubernetes with contributor docs in kubernetes/community; Node.js, Vue and Vite do the
same. The alternative, one surface owning everything, fails in both directions: a user reading a
monorepo's `backend/docs/` needs a checkout to find it, and a contributor's invariant on a product
page rots the moment the code changes, because the site's pull requests do not touch the code.

The execution turned up six findings that no rule predicted, and each one is a check the next
documentation change should run.

**A pointer is not a split.** The reduction item was ticked once with five docs reduced and fourteen
carrying unchanged prose under a fresh pointer: material ADDED to the site rather than moved off
this repository, which is rule 1's failure mode re-made inside the slice written to end it. Three
things let it happen: a pointer is cheap and nine of them read as nine docs handled; "not assessed"
was recorded honestly in a table and invisibly in a checkbox; and growing the site is the
satisfying half while cutting the doc it duplicates is fiddly and is where the value is. **Count
lines removed, not docs touched.** Final: 24 mixed docs, 21 reduced, roughly 2,700 lines cut.

**Existence is not coverage.** The audit recorded whether a website page existed, and three
reductions found the named page stopping above the depth the repo doc carried. A section count made
the site look like the senior partner. Before cutting a section, open the target and check DEPTH,
and write the verdict back where the next pass will read it.

**A page can resolve, be deep enough, and still be WRONG.** Two Extend pages taught APIs that had
been deleted: one imported `wireProvider` / `isProviderWired` as module functions from the kernel,
which stopped being exported when provider wiring moved to an app-owned registry; the other passed
`environmentProvider` to `buildNodeContainer` / `startLocal`, an option removed when environment
backends became a registry keyed by `kind`. Both passed every check this initiative had. A code
example is not a link, so no crossing guard can see it, and neither repository's CI can typecheck
the other's prose. **When the two disagree about what exists, believe the repo doc**, because it is
the one a code change's own pull request has to touch.

**Where a repo doc is many times its page, the reduction is BLOCKED on a page that does not exist,
and finding that out is the assessment.** `mcp-tool-servers.md` was 723 lines against 65 on the
site; `debug-api.md` 433 against 25; `kubernetes-topology.md` had no counterpart at all. The
correct move is to write down what the page OWES and leave the content where a reader can still
reach it. Every item that did so was cheap to pay later, because the list was the specification;
the two that instead ASSERTED the page existed left about 600 lines reachable from nowhere behind
two pointers that 404'd.

**A circular cross-link is what a missing destination looks like.** Two site pages each named the
other as the authority on initiative presets and neither held it. Every link resolved, so nothing
was broken in any way a checker can see: the material simply did not exist. When a page says "see X
for how", open X and confirm it does.

**Repo-to-repo duplication is a class the audit structurally could not see.** It asked, per doc,
what the WEBSITE should own, and never what a SIBLING doc already owned. Four cases surfaced, and
the rule they suggest held on every later pass: **a doc that names another as "the full model" may
not also contain that model.** Say what the reader needs in order to decide whether to follow the
link, then link.

**An absence cell rots in the expensive direction.** A slice that lands a page does not come back to
unset the row claiming a gap, so the next slice re-scopes a topic as a move rather than a
reconciliation. Three "no website page today" entries had quietly gained pages. The close-out
therefore re-derived the row from scratch against the live navigation rather than trusting it: all
46 docs under `backend/docs/` and `docs/`, checked against the site's sidebar. Exactly one survived,
`local-kubernetes-setup-windows.md`, and the reader test answered it: someone whose `cat-factory
k3s` run stops at "k3s runs only on Linux" has no checkout in that story, so installing the CLIs and
creating the cluster went to the site
([cat-factory-website#30](https://github.com/kibertoad/cat-factory-website/pull/30)) and the
`K8S_IT_*` suite wiring and the CI-tracking version pins stayed here.

## Consequences

**Where a doc goes is now decidable, and stated in three places a contributor already reads**:
`docs/README.md` and `CONTRIBUTING.md` ("Where does a new doc go?") and `CLAUDE.md`'s
documentation-staleness sweep.

**The ordering rule is phrased as an ACTION, because as a belief it failed.** Open the website pull
request first, NAME it in this one's description, and LOAD the page before linking it. A slice that
wrote a page in its plan and then reduced against that plan read its own intent as an accomplished
fact, and every artefact it produced afterwards repeated the claim rather than checking it.
Asserting the page exists is what failed; opening the URL is what would not have.

**Four link guards now cover what care did not**, and each covers something the others cannot:

- `check-doc-links.mjs`: ordinary relative markdown links between repo docs, to a path AND a
  heading. It matters most where this repository deletes docs on purpose: a completed tracker
  converts to an ADR and is `git rm`ed, which dangles every doc that linked it. It says the link is
  dead; only a person knows what it should now say.
- `check-doc-anchors.mjs`: doc URLs built in CODE, across the three modules that build them
  (`config/docs.ts`, `vcs-errors.ts`, `providers/docs.ts`). This coupling has no other observer: a
  test on a composed string cannot see whether the heading exists, which is how one reduction sent
  an operator following a warning to a page whose `## Setup` it had deleted in the same commit.
- `check-shipped-doc-links.mjs`: both directions of a published tarball's links.
- `check-repo-links.mjs`, in the WEBSITE repository, weekly: every crossing link in both
  directions, with no page list and no network because both checkouts are on disk. It is
  deliberately NOT a pull-request gate: the two repositories merge independently, so a paired change
  legitimately leaves one side leading, and as a gate it would go red on the reviewing repository
  for a reason that pull request cannot fix, which is how a guard gets ignored and then deleted.

**Generated CHANGELOGs are excluded from all of it**, on purpose and after re-examination. A
changelog entry is a claim about what was true at a released version, and a link inside it is part
of that claim; re-pointing it at a file's new path would make the entry describe a repository layout
that did not exist when the version shipped. Thirty-three dangling targets stay dangling, and the
guards say so where they skip.

**Section headings are load-bearing in ways nothing reveals locally.** Before reducing a doc, grep
`config/docs.ts`, `vcs-errors.ts` and `providers/docs.ts` for it, and check what deep-links its
headings from other docs and from shipped `README`s. A remedy whose instruction the website now owns
moves to `SITE_DOCS`; one about this repository's internals keeps its heading.
`model-support.md`'s section NUMBERING is pinned by runtime error messages, so its sections may be
reduced but not renumbered.

**The reduction pass doubles as a REVIEW of the site**, and that is the part worth keeping. Both
website corrections and one stale provider list here were found by a person reading a doc beside its
live page and noticing they disagreed about what exists. Nothing scheduled would have caught any of
them.

**The exposure this creates is over a hundred `catfactory.ai` links built from this repository**, in
docs, code and shipped `README`s, and every reduction adds more because the pointer IS the
deliverable. The reader who loses is the one following a pointer out of a doc that no longer carries
the content: the material then exists nowhere they can reach. The weekly crossing guard is what
resolves them, and the human check is what keeps them true.
