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

**In**: any place we hand-build a request against a service we do not run. §1 derives the list
rather than reciting it, but so a reader knows the shape: the vendor REST/GraphQL clients (GitHub,
GitLab, Jira, Confluence, Linear, Notion, Figma, Zeplin, Slack, Datadog, incident.io, PagerDuty,
Cloudflare, SendGrid, Resend, Brave Search, SearXNG, Langfuse, the OTLP collector protocol, the
Kubernetes API), every hand-rolled OAuth surface, the npm registry read in
`scripts/check-release-versions.mjs`, and two things whose base URL is configured but whose wire
shape is still ours: the `${upstream.baseURL}/chat/completions` the LLM proxy appends, and the
per-provider base URLs typed out in `backend/packages/agents/src/providers/endpoints.ts` (the SDK
sends the request, but the host and the `/v1` suffix are ours to get wrong).

**OAuth is more than one directory.** `backend/packages/server/src/auth/` holds the GitHub, Google
and Linear flows, and three more live outside it: `DocumentSourceOAuthService.ts` runs the
authorization-code and refresh exchanges for Figma, Zeplin and Notion against the endpoints its
`*.logic.ts` siblings declare; `modules/mcpOAuth/mcpOAuthClient.ts` is hand-rolled on `fetch` and
walks the RFC 8414 / RFC 9728 well-known metadata locations against arbitrary vendor MCP servers
before three token calls; `modules/mcpAuthServer/` speaks the same vocabulary from the other side.
Well-known paths and dynamic client registration are exactly the spec surface vendors move.

**Out, and say so in the record rather than leaving the reader to wonder**:

- **SDK-mediated calls.** `@ai-sdk/*`, `ai`, `workers-ai-provider`, `@aws-sdk/*`, the database
  drivers. The SDK owns the wire shape, so currency there is a dependency bump under the
  `minimumReleaseAge` rules, not this sweep. Name the boundary: an SDK we PIN to an old major
  (the Vercel AI SDK family is held to the major that pairs with `workers-ai-provider`) is a
  finding for the dependency sweep, and this record may point at it in one line.
- **Our own surfaces**: `/api/v1`, `/internal/*`, the runner and container HTTP, the persistence
  RPC. Those are governed by the public-API stability rules in CLAUDE.md.
- **Build-time supply chain**: the `download.docker.com` apt repo, `repo1.maven.org`,
  `https://get.k3s.io`, and the registries a job's own `npm install` hits (the harness only WRITES
  the npmrc that routes them; it reads no registry itself). They break a build rather than a run,
  and they move on the image's schedule. Excluded deliberately, named in the record's scope section.

## 1. Derive the inventory, never inherit it

**The previous record is evidence, not an inventory.** It was true against a commit the tree has
moved past, and an entry that quietly disappeared from the code is exactly what a copied table
hides. Re-derive every run, then diff against the old record to produce the "since last sweep"
section.

**Do not retype the derivation; run it.** The call-site walk lives in
`scripts/check-external-api-inventory.mjs`, which CI also runs as a guard:

```
node scripts/check-external-api-inventory.mjs --list
```

It walks every non-test source file under `backend/`, `frontend/`, `scripts/` and `sdk/` for an
outbound call in call position, and its `CLASSIFICATION` map accounts for each one as a vendor
surface (naming whose docs settle it) or as one of ours (naming why no vendor page can make it
wrong). Read the map: it IS the vendor list, and its `internal` reasons are the exclusions the
record's scope section owes its reader. Because CI checks it, a call site classified nowhere fails
the pull request that adds it, so an integration landing BETWEEN sweeps cannot sit unswept for
months. That is the half a periodic job structurally cannot cover.

Two things it will not tell you, so grep for them too:

- **Hosts and base URLs**, which decide what a verdict is ABOUT. ``https?://[^\s'"`)]+`` in
  non-test source, wide enough for a template literal (`https://${ZEPLIN_API_HOST}/v1` is invisible
  to a `[a-z0-9.-]` host pattern), plus `(API_HOST|API_BASE|BASE_URL)\s*=` for the hosts that never
  appear with a scheme (`figma.logic.ts` holds a bare `'api.figma.com'`).
- **The version pins**: `api-version|Notion-Version|notion-version|/rest/api/|/api/v[0-9]|/v[0-9]+/|graphql`.
  This is the one grep that finds a file which SENDS no request and still has to change when a pin
  moves, the acceptance fakes being the live example.

Then close the gaps none of the three reaches:

- **A base URL that only ever arrives from config.** Confluence composes
  `${credentials.baseUrl}/wiki/rest/api/content/...`, a self-hosted GitLab and a Jira site do the
  same. No host appears in the source at all, and the PATH is still ours to get wrong.
- **The configured-but-unswept vendor.** Cross-check the derived list against
  [`docs/environment-variables.md`](../../../docs/environment-variables.md), the capability
  credential kinds (`modules/providers/userSecretKinds.ts`, `modules/capabilityCredentials/`) and
  every directory under `backend/packages/integrations/src/modules/` (there are more than thirty;
  naming a handful here is how this cross-check quietly narrows to the vendors you already had). A vendor
  a deployment can configure but whose call site the walk missed is what this cross-check exists to
  close. Assert the RELATION (every configurable vendor is either swept or excluded with a reason),
  never a count.

**A shared API gets EVERY site listed in its row**, because moving one and missing the rest is the
likeliest bad outcome of this sweep. GitHub is the worked example, and it is worse than it looks:
`x-github-api-version: 2022-11-28` is sent from FOURTEEN non-test files. Five reach it through an
`API_VERSION` identifier, and even those are four separate constants (`githubHttpHelpers.ts`
EXPORTS one, which `FetchGitHubClient.ts` and `viewerTokenReads.ts` import; `GitHubAppAuth.ts`,
`FetchGitHubProvisioningClient.ts` and `auth/GitHubOAuth.ts` each declare a private one). The other
NINE carry the literal inline, including the harness's own `vcs-api.ts`, `runtimes/local/src/github.ts`,
two files under `modules/providers/`, and the two acceptance fakes that mirror the pin so the fake
still matches. Counting the constants and stopping is the mistake: they reach five of fifteen files
a version move must touch.

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

Past about six integrations this does not fit in one context, and serialising twenty vendors at two
or more fetches each is forty round trips for no reason: the verifications share no state. Fan them
out, one subagent per vendor, each returning its verdict WITH the page URL and the date it read and
NOT the search transcript. That isolation is the point (a changelog is the bulkiest thing this
skill reads and none of it needs to outlive the verdict). Ordering, severity and the record stay
here.

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

**The two axes order the table together, worst first: Broken, Deprecated with a date, Unverifiable,
Drifting, Current; within a verdict by severity, then by vendor name.** Unverifiable outranks
Drifting on purpose. An unchecked call may be either of the two above it, and filing it below a
known-and-benign one is the same collapse the verdict exists to refuse. Fixing the order also
matters because the "since the last sweep" diff is read off this table: with no defined order, two
sweeps of an unchanged tree produce churn that reads as movement.

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

For each, state the cost too. A new scope on an existing connection is a re-consent for every
deployment, and anything an operator must act on ships as a website PR first (ADR 0051).

**A new credential costs one decision before either, and getting it backwards breaks the feature.**
A deployment-level PLATFORM variable is documented in
[`docs/environment-variables.md`](../../../docs/environment-variables.md), and that entry is what
`check-reserved-env-keys.mjs` uses to RESERVE the name. A per-capability credential (ADR 0041) is
the opposite case: it is declared by name on the agent kind or tool server and resolved through the
kernel `ToolSecretResolver`, and documenting it in that file is precisely what would make it
unusable, because `isReservedPlatformEnvKey` refuses a reserved name as a credential key. Say which
of the two an opportunity needs; do not write "document the new variable" over both.

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
tree, not about a calendar. On the run that creates the file the previous date is written as
`none (first sweep)`: never blank, never omitted, never invented. That line is what a later sweep
reads to build its diff, so it is the last place an absent fact may look like a checked one.

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
  heavier PR by construction, which is another reason a shared API's row lists every call site
  rather than the tidy few that share a constant.

Anything the sweep touches that spans several PRs earns a tracker under `docs/initiatives/`; a
single adoption does not.

## 7. PR

Docs-only, `docs:` prefix, empty changeset. Before opening:

- `node scripts/check-doc-links.mjs` and `node scripts/check-doc-anchors.mjs` (the record links
  source files and headings).
- `node scripts/check-external-api-inventory.mjs`. If the sweep found a call site the walk did not,
  the fix is in that script's detector or its `CLASSIFICATION` map, and it belongs in THIS PR: the
  next sweep inherits the tool, not the prose you worked around it with.
- `node --test 'scripts/*.test.mjs'` when you touched the inventory script.
- `pnpm lint:fix` from the root, once, whole tree.

The description is a reviewer briefing: lead with the verdict counts and every Broken or
Deprecated-with-a-date finding, name the opportunities worth taking and the ones deliberately
passed over, and say plainly what could not be verified. Leave the per-integration account in the
record. A reviewer's first question is "what do we have to do now", so answer it in the first
paragraph.
