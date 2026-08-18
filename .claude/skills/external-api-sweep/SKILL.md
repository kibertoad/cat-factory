---
name: external-api-sweep
description: Sweep every hand-written (non-SDK) external API call in this repo and check each against the vendor's LIVE documentation: are the paths, version pins, auth schemes and read fields still correct, and has the vendor shipped anything cat-factory should adopt. Use when asked to audit, sweep or re-verify the external APIs or third-party integrations ("are our external API calls still current", "check our Jira/Notion/GitHub API usage", "run an API sweep", "what have our vendors added"). Writes the record to `docs/internal/external-api-sweep.md`, overwriting the previous one, and opens the PR.
---

# External API sweep

Most third-party surfaces this repo talks to are reached by HAND: a `fetch` against a path we
typed, a version header we pinned, a JSON field we read by name. Nothing in CI can see when the
vendor moves one. Typecheck passes, every unit test passes (they run against our own fakes), and
the failure arrives in production as a 404 on someone's run.

That is not hypothetical here. `JiraProvider.ts` carries the scar in a comment: Atlassian removed
`GET /rest/api/3/search` in May 2025 and the call had to move to `/rest/api/3/search/jql`. This
sweep exists to find the next one before a run does.

Two questions per integration, and the second is not a bonus:

1. **Is what we send still correct?** Path, version pin, auth scheme, required parameters, the
   fields we read off the response, the errors we branch on.
2. **Did the vendor ship something we should take?** A new endpoint, field, filter or webhook that
   removes an N+1, a poll loop, or a capability we currently degrade on.

Hold one posture throughout: **your training data is not evidence.** The cutoff predates the
sweep, which is the entire reason the sweep is a periodic job rather than a one-off. Every verdict
cites a vendor page you READ this session, with the URL and the date. A verdict from memory is
worth less than no verdict, because it reads as checked.

## What is in scope

**In**: any place we hand-build a request against a service we do not run. Vendor REST/GraphQL
(GitHub, GitLab, Jira, Linear, Notion, Slack, Datadog, incident.io, PagerDuty, SendGrid, Resend,
Google Generative Language, OpenRouter, Langfuse, Brave Search), the OAuth/identity endpoints under
`backend/packages/server/src/auth/`, the Kubernetes API paths we compose in
`kubernetes-environment.logic.ts`, the package-registry reads in the harness and in
`scripts/check-release-versions.mjs`, and the OpenAI-compatible wire shape the LLM proxy appends by
hand (`${upstream.baseURL}/chat/completions`) even though its base URL is configured.

**Out, and say so in the record rather than leaving the reader to wonder**:

- **SDK-mediated calls.** `@ai-sdk/*`, `ai`, `workers-ai-provider`, `@aws-sdk/*`, the database
  drivers. The SDK owns the wire shape, so currency there is a dependency bump under the
  `minimumReleaseAge` rules, not this sweep. Name the boundary: an SDK we PIN to an old major
  (the Vercel AI SDK family is held to the major that pairs with `workers-ai-provider`) is a
  finding for the dependency sweep, and this record may point at it in one line.
- **Our own surfaces**: `/api/v1`, `/internal/*`, the runner and container HTTP, the persistence
  RPC. Those are governed by the public-API stability rules in CLAUDE.md.
- **Build-time supply chain**: the `download.docker.com` apt repo, `repo1.maven.org`,
  `https://get.k3s.io`. They break a build rather than a run, and they move on the image's
  schedule. Excluded deliberately, named in the record's scope section.

## 1. Derive the inventory, never inherit it

**The previous record is evidence, not an inventory.** It was true against a commit the tree has
moved past, and an entry that quietly disappeared from the code is exactly what a copied table
hides. Re-derive every run, then diff against the old record to produce the "since last sweep"
section.

Start from call sites rather than from hosts, because a base URL that arrives from config still
carries a hand-typed path:

- `await fetch\(|fetchImpl\(|globalThis\.fetch\(` across `backend/`, `scripts/`, `frontend/app/`,
  excluding `*.test.ts` / `*.spec.ts` / `**/test/**`.
- `https://[a-z0-9.-]+\.[a-z]{2,}` in non-test source, to catch the constants
  (`LINEAR_GRAPHQL_URL`, `API_BASE`, the `apiBase ?? 'https://…'` defaults).
- The version pins themselves: `api-version|Notion-Version|notion-version|/rest/api/|/api/v[0-9]|/v[0-9]+/|graphql`.

Then close the three gaps a `backend/packages` grep structurally cannot see:

- **`backend/internal/executor-harness/src/`.** The harness has its OWN VCS client (`vcs-api.ts`)
  pinning `x-github-api-version: 2022-11-28` inline, and inside the package tree that same pin is
  re-declared as a private `API_VERSION` constant in `githubHttpHelpers.ts`, `GitHubAppAuth.ts` and
  `FetchGitHubProvisioningClient.ts`. One API, four pins, one of them outside the tree a package
  grep walks. A shared API gets EVERY site listed in its row, because moving one and missing the
  rest is the likeliest bad outcome of this sweep.
- **`scripts/` and `frontend/app/`.** A registry read in a guard script is still an external API.
- **The configured-but-unswept vendor.** Cross-check the derived list against
  [`docs/environment-variables.md`](../../../docs/environment-variables.md), the capability
  credential kinds (`modules/providers/userSecretKinds.ts`, `modules/capabilityCredentials/`) and
  `modules/tasks` / `modules/documents` / `modules/observability`. A vendor a deployment can
  configure but whose call site your grep missed is the one hole this cross-check exists to close.
  Assert the RELATION (every configurable vendor is either swept or excluded with a reason), never
  a count.

Record for each entry: the vendor, the API and version, every `file:line` that talks to it, what
the platform loses if it breaks, and whether the base URL is fixed or deployment-supplied (a
self-hosted GitLab, a Jira site, a Datadog EU site all move the host but keep the path).

## 2. Verify against the vendor, one integration at a time

WebFetch the vendor's own reference page for the exact endpoint, plus its changelog / deprecation
page. WebSearch for the endpoint name plus "deprecated" or "sunset" when the reference page is
silent, since vendors routinely announce in a changelog and never touch the reference.

Check, in this order (the first three are what actually breaks):

- **The path still exists at that version.** This is the Jira class of failure.
- **The version pin.** A pin is not automatically stale: `x-github-api-version: 2022-11-28` and
  `notion-version: 2022-06-28` are pinned ON PURPOSE, and moving one is a behaviour change, not
  hygiene. What matters is whether the vendor has ANNOUNCED an end for it, and whether the pin is
  now so far back that new fields we want are unreachable. Report the pin, the vendor's current
  version, and whether there is a dated sunset. An UNPINNED call against a versioned API is the
  worse finding of the two: it floats.
- **Auth.** The scheme we send (bearer, basic, token, `x-goog-api-key` as a header rather than a
  `?key=` query parameter) and whether the vendor has changed what it accepts or what scopes the
  operation now needs.
- **Required and defaulted parameters.** A parameter that became required, a default that moved
  (page sizes, `maxResults`, expansion flags), a filter we pass that is now ignored.
- **Response fields we read by name.** We parse these by hand, so a renamed or nullable-ified field
  is a silent wrong answer rather than an error.
- **Pagination and rate limits.** Whether the cursor/link scheme we implement is still the
  documented one, and whether the vendor now returns retry headers we ignore.
- **Error semantics we branch on.** Status codes and error bodies that steer a refusal or a retry.

Past about six integrations, verify them one investigation at a time and keep each verdict with its
citation rather than the search transcript.

## 3. Verdicts

One per integration, and the last two are not decoration:

- **Current.** Verified against the vendor page, no announced change.
- **Deprecated with a date.** Still working, sunset announced. Carries the DATE and what replaces
  it. This is the finding that earns the sweep.
- **Broken.** The vendor has already moved. Urgent, and §6 says what to do with it.
- **Drifting.** Works, but we are behind in a way that costs us: an old pin blocking a field we
  want, a hand-rolled poll where a webhook now exists, a pagination scheme the vendor now calls
  legacy.
- **Unverifiable.** The vendor doc is gated, gone, or does not describe this endpoint. Say WHICH,
  and say what would settle it. Never fold one of these into Current: an unchecked call and a
  checked-and-correct call are precisely the pair CLAUDE.md's degrade-loudly rule is about, and the
  next sweep pays for collapsing them.

Severity is ours: breaks a run path with no fallback is High; an optional integration degrading
(a missed Slack notification, dropped Langfuse traces) is Medium; ergonomics is Low.

## 4. Opportunities, tied to a consumer

The second half of the sweep, and the half that rots into a vendor press release if it is written
loosely. **An addition qualifies only when you can name the cat-factory capability it serves and
the file that would change.** "Vendor shipped batch endpoints" is noise. "Jira's bulk-fetch would
collapse the per-issue reads behind `JiraProvider.listBugCandidates` into one call, which the
no-N+1 rule already demands" is a finding.

The highest-value shapes, given how this platform works:

- **A batch/bulk endpoint** replacing a per-item read. CLAUDE.md bans N+1 repository access for our
  own store; an N+1 against a vendor costs latency AND rate limit.
- **A webhook replacing a poll.** The polling gates (`ci`, `conflicts`) and the tracker sweeps are
  where this pays.
- **A field that removes a guess**, letting something we currently render as unknown or absent be
  stated honestly.
- **A narrower scope or a shorter-lived token** for a credential we already hold.

For each, state the cost too: a new scope on an existing connection is a re-consent for every
deployment, a new credential means a `docs/environment-variables.md` entry under the reserved-keys
guard, and anything an operator must act on ships as a website PR first (ADR 0051).

## 5. Write the record

**Fixed path, whole-file overwrite: `docs/internal/external-api-sweep.md`** (unlinked here on
purpose: the file does not exist until the first run, and `check-doc-links.mjs` fails a link into
empty space). Never a dated filename, never an appended section. One record, always the latest, so nobody has to
work out which of five files is current. Read the OLD file before overwriting it: its date and
verdicts are the input to the "since the last sweep" section, and they are gone the moment you
write.

The header carries, on its own lines: the sweep timestamp (`date -u +'%Y-%m-%d %H:%M UTC'`), the
commit swept (`git rev-parse --short HEAD`), the previous sweep's date, and one line naming who ran
it (the skill). A record without a commit is unusable, because "still correct" is a claim about a
tree, not about a calendar.

Then:

- **Scope**, including what was excluded and why (SDK-mediated, our own surfaces, build-time supply
  chain). A reader must not have to guess whether the AI SDK was forgotten.
- **Summary table**: `Vendor | API + version | Call sites | Verdict | Severity`. One row per
  integration, sorted worst verdict first.
- **Since the last sweep**: verdicts that MOVED, entries that appeared, entries that vanished from
  the tree. On the first run, say it is the first run.
- **One section per integration**: what we call with `file:line`, what was checked, the vendor page
  URL with the date read, the verdict with its evidence, and any opportunity.
- **Opportunities**, gathered, each with its consumer, the file that would change, and its cost.
- **Unverified**, listed separately with what would settle each.
- **Follow-ups**: the fixes this sweep hands off, with PR or issue links as they land.

Do not add this file to `DOC_ALLOWANCES` in `scripts/check-file-size.mjs`. It is regenerated
wholesale, so a shrink-only ratchet on it would fail the next honest sweep that found more.

On the FIRST run the file is new, so add its one-line entry to
[`docs/README.md`](../../../docs/README.md) under the contributor-only section, describing it as
regenerated by this skill rather than as a frozen point-in-time record. On later runs, check the
entry is still there.

## 6. Fixes are separate PRs

**The sweep records; it does not refactor.** The record PR is docs-only with an empty changeset, so
it can be read and merged on its own evidence. A code fix in the same PR turns a reviewable audit
into a diff nobody can grade.

Two exceptions to how the handoff is made, neither of which changes that rule:

- **A Broken verdict on a run path is urgent.** Say so at the top of the record and in the PR
  description, and open the fix as its own PR immediately after this one lands. Do not let it wait
  for the next sweep.
- **A fix touching `backend/internal/executor-harness/src/` bumps the runner image** and the pinned
  tag everywhere it appears (see CLAUDE.md, Releases & changesets). That makes it a separate,
  heavier PR by construction, which is another reason the shared-API rows list both call sites.

Anything the sweep touches that spans several PRs earns a tracker under `docs/initiatives/`; a
single adoption does not.

## 7. PR

Docs-only, `docs:` prefix, empty changeset. Before opening:

- `node scripts/check-doc-links.mjs` and `node scripts/check-doc-anchors.mjs` (the record links
  source files and headings).
- `pnpm lint:fix` from the root, once, whole tree.

The description is a reviewer briefing: lead with the verdict counts and every Broken or
Deprecated-with-a-date finding, name the opportunities worth taking and the ones deliberately
passed over, and say plainly what could not be verified. Leave the per-integration account in the
record. A reviewer's first question is "what do we have to do now", so answer it in the first
paragraph.
