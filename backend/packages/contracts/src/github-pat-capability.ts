import * as v from 'valibot'

// ---------------------------------------------------------------------------
// What the GitHub personal access token a workspace's runs authenticate with can actually
// DO, answered once the board has loaded rather than discovered when a run fails at its push.
//
// A PAT is the operational credential on two deployment shapes: local mode, where one token is
// both the sign-in identity and what every agent step clones, pushes and merges with, and a
// hosted deployment whose run initiator stored a `github_pat`, which OUTRANKS the App
// installation on the run path (`backend/docs/security-model.md`, Layer 3). On both, a token
// minted without `repo` reaches its first failure several steps into a pipeline, as a 403 out
// of a container, after the run has already spent money.
//
// This module holds the vocabulary BOTH sides agree about: the backend probes, the SPA renders
// the verdict and the re-mint link, so the capability list, which capabilities are BLOCKING,
// and the scopes a replacement token needs live here instead of being restated on each side.
//
// Deliberately not a boolean, and deliberately per-capability. GitHub reports a CLASSIC token's
// scopes in the `x-oauth-scopes` header and reports nothing whatsoever for a fine-grained one,
// whose reach is knowable only by probing a repository — which answers for push and answers
// nothing for the rest. "Not granted" and "not knowable" are different facts with different
// remedies, so each capability carries its own tri-state and an unknowable one says so.
// ---------------------------------------------------------------------------

/**
 * Which credential the check looked at — the two shapes on which a PAT is what a run
 * authenticates as. Named on the wire because the REMEDY differs: a `deployment` token is
 * replaced by whoever runs the deployment, an `initiator` one by the signed-in user in their
 * own settings, and a banner that could not tell them apart would send half its readers to a
 * page they cannot act on.
 */
export const githubPatSourceSchema = v.picklist(['deployment', 'initiator'])
export type GitHubPatSource = v.InferOutput<typeof githubPatSourceSchema>

/**
 * How a token's reach was determined, mirroring `describeGitHubPatScope`'s own classification.
 * `unknown` is a token GitHub accepted while reporting no scopes and whose prefix is not the
 * fine-grained one, so nothing about its breadth can be stated.
 */
export const githubPatKindSchema = v.picklist(['classic', 'fine_grained', 'unknown'])
export type GitHubPatKind = v.InferOutput<typeof githubPatKindSchema>

/**
 * The things a pipeline needs the token to be able to do. Kept to what actually stops work:
 * every step from the coder onward pushes a branch, the merger opens and merges a pull
 * request, and the coder/ci-fixer may edit `.github/workflows/*`.
 *
 * Read-only reach is absent on purpose. A token that cannot read the repository fails at
 * `GET /user` or at the repo probe, which is `token_rejected` / an unreadable repo rather than
 * a capability verdict.
 */
export const githubPatCapabilitySchema = v.picklist(['push', 'pullRequests', 'workflows'])
export type GitHubPatCapability = v.InferOutput<typeof githubPatCapabilitySchema>

/** Every capability, as a plain tuple — the source of truth for iteration. */
export const GITHUB_PAT_CAPABILITIES = githubPatCapabilitySchema.options

/**
 * Whether the token holds one capability.
 *  - `granted` — positively established (a classic scope GitHub named, or a repo probe that
 *    reported `permissions.push`).
 *  - `missing`  — positively established as ABSENT. The only status that raises a banner.
 *  - `unknown`  — not determinable from what GitHub exposes. NOT a synonym for either: a
 *    fine-grained token's pull-request and workflow permissions have no endpoint that reports
 *    them, and rendering that as `granted` would silence a real gap while rendering it as
 *    `missing` would nag every correctly-configured fine-grained deployment forever.
 */
export const githubPatCapabilityStatusSchema = v.picklist(['granted', 'missing', 'unknown'])
export type GitHubPatCapabilityStatus = v.InferOutput<typeof githubPatCapabilityStatusSchema>

/**
 * The per-capability verdict. Spelled as an explicit object rather than a `v.record` over the
 * picklist so a new capability fails the typecheck at every construction site instead of
 * silently defaulting to absent; `githubPatCapabilities.spec.ts` pins the two lists together.
 */
export const githubPatCapabilitiesSchema = v.object({
  push: githubPatCapabilityStatusSchema,
  pullRequests: githubPatCapabilityStatusSchema,
  workflows: githubPatCapabilityStatusSchema,
})
export type GitHubPatCapabilities = v.InferOutput<typeof githubPatCapabilitiesSchema>

/**
 * The capabilities whose absence STOPS a pipeline, as opposed to narrowing what it may change.
 *
 * `workflows` is deliberately not among them, and it is the exclusion worth stating: without it
 * a run pushes, opens its PR and merges exactly as normal, and fails only on the subset of
 * changes that touch `.github/workflows/*`. Treating that as blocking would raise the loud
 * banner on the many deployments whose agents never edit CI, which is how a warning surface
 * teaches people to dismiss it unread.
 */
export const GITHUB_PAT_BLOCKING_CAPABILITIES = [
  'push',
  'pullRequests',
] as const satisfies readonly GitHubPatCapability[]

/**
 * The classic scopes a replacement token needs, and the single source of truth for them: the
 * local facade's setup link, the SPA's re-mint link and this module's own classification all
 * read this one list.
 *
 * `repo` covers cloning, pushing a branch, opening the pull request, reading the head's Actions
 * check runs for the CI gate and merging. `workflow` is needed only to push a change that
 * touches a workflow file, but it is pre-selected anyway: a token is minted once, and sending
 * someone back to GitHub a second time the first time an agent edits CI is worse than the
 * narrower grant is worth. What it costs is stated in `githubPatScope.ts`.
 */
export const GITHUB_PAT_CLASSIC_SCOPES = ['repo', 'workflow'] as const

/**
 * The fine-grained REPOSITORY permissions a replacement token needs, for the banner to list.
 * Prose rather than a query parameter because GitHub's fine-grained token form accepts no
 * prefill: see {@link githubPatCreateUrl}.
 */
export const GITHUB_PAT_FINE_GRAINED_PERMISSIONS = [
  'contents:write',
  'pull_requests:write',
  'workflows:write',
] as const

/**
 * Where each token kind is minted, relative to the instance's web root. Exported because the
 * SPA's generic connect-box link (`vcsTokenCreateUrl`, which offers no scopes) has to land on
 * the same page this module's pre-filled link does; two spellings of GitHub's settings path
 * would send the two surfaces to different places the day GitHub moves one.
 */
export const GITHUB_TOKEN_CREATE_PATHS: Record<GitHubPatKind, string> = {
  classic: '/settings/tokens/new',
  fine_grained: '/settings/personal-access-tokens/new',
  // Nothing is known about the token in play, so the form that CAN be pre-filled is the better
  // landing place: it arrives with the right scopes ticked, and a reader who wanted the
  // fine-grained one is one link away on the same settings page.
  unknown: '/settings/tokens/new',
}

/** Strip a trailing slash so a host and a path never join into a double slash. */
function root(webUrl: string): string {
  return webUrl.replace(/\/+$/, '')
}

/**
 * The URL that mints a replacement token, pre-filled as far as GitHub allows.
 *
 * The KIND is carried over from the token being replaced rather than chosen for the user: a
 * deployment that standardised on fine-grained tokens should not be pushed back to a classic
 * one by a warning banner, and vice versa.
 *
 * Only the CLASSIC form takes a prefill. GitHub's fine-grained form accepts no permission query
 * parameters at all, so that half of the fork is a bare link and the caller must render
 * {@link GITHUB_PAT_FINE_GRAINED_PERMISSIONS} beside it — a link that silently arrived with
 * nothing selected would read as "these are already set for you", which is precisely the
 * misreading that produced the missing permission in the first place.
 *
 * `webUrl` is the instance the workspace is bound to; absent, the caller has already decided to
 * fall back to the public host (the SPA's `vcsTokenCreateUrl` states why that is safe for a
 * settings page and not for a repository link).
 */
export function githubPatCreateUrl(
  kind: GitHubPatKind,
  options: { webUrl: string; description?: string },
): string {
  const page = `${root(options.webUrl)}${GITHUB_TOKEN_CREATE_PATHS[kind]}`
  if (kind === 'fine_grained') return page
  // Hand-built rather than via `URLSearchParams`: this package is dependency-free and compiles
  // with neither the DOM nor the Node lib, and it is imported by the SPA, both facades and the
  // local runtime alike — so the one place the query string is assembled cannot assume a global.
  const query = [
    `scopes=${encodeURIComponent(GITHUB_PAT_CLASSIC_SCOPES.join(','))}`,
    ...(options.description ? [`description=${encodeURIComponent(options.description)}`] : []),
  ]
  return `${page}?${query.join('&')}`
}

/**
 * What the check found about the token a workspace's runs would use.
 *
 * `probedRepos` / `unprobedRepoCount` exist because the fine-grained answer is a SAMPLE: the
 * probe reads the repositories linked to this board, capped, and a reader who assumed it read
 * all of them would take a clean verdict as a guarantee about a repository nobody looked at.
 * Both are empty/zero for a classic token, whose scopes answer for every repository at once.
 */
export const githubPatCapabilityReportSchema = v.object({
  source: githubPatSourceSchema,
  kind: githubPatKindSchema,
  /** The classic scopes GitHub named, in header order. Empty for the other kinds. */
  scopes: v.array(v.string()),
  capabilities: githubPatCapabilitiesSchema,
  /** The `owner/name` of each repository the probe actually read. */
  probedRepos: v.array(v.string()),
  /** Linked repositories the probe's cap left unread, so a verdict never reads as exhaustive. */
  unprobedRepoCount: v.number(),
  /** The instance the token authenticates against, for the re-mint link. Null ⇒ not derivable. */
  webUrl: v.nullable(v.string()),
})
export type GitHubPatCapabilityReport = v.InferOutput<typeof githubPatCapabilityReportSchema>

/**
 * The check's outcome. A variant rather than a nullable report because the four states need
 * four different reactions, and three of them are not "the token lacks something":
 *
 *  - `not_applicable` — no PAT is in play (a GitHub App deployment, GitLab, or nothing
 *    connected at all). There is no token whose reach could be wrong.
 *  - `token_rejected` — GitHub refused the token outright (401/403). Blocking, and a strictly
 *    worse problem than a missing scope, so it gets its own state instead of collapsing into
 *    "everything is missing".
 *  - `probe_failed`   — GitHub could not be reached, or answered in a way the probe could not
 *    read. NOT a verdict about the token: an upstream outage must never render as a permissions
 *    problem, because the remedy it would advertise (mint a new token) is wrong and costly.
 *  - `checked`        — a report was produced. It may still be entirely clean.
 */
export const githubPatCheckSchema = v.variant('state', [
  v.object({ state: v.literal('not_applicable') }),
  v.object({ state: v.literal('token_rejected'), status: v.number() }),
  v.object({ state: v.literal('probe_failed'), message: v.string() }),
  v.object({ state: v.literal('checked'), report: githubPatCapabilityReportSchema }),
])
export type GitHubPatCheck = v.InferOutput<typeof githubPatCheckSchema>

/**
 * The capabilities a report positively established as ABSENT, split by whether losing them
 * stops a pipeline. `unknown` is in neither list by construction — see
 * {@link githubPatCapabilityStatusSchema} for why it may not be folded into either.
 *
 * The one reduction both the banner and its tests read, so "is there anything to say" and "what
 * do we say" can never disagree about which capability belongs on which side.
 */
export function missingGitHubPatCapabilities(report: GitHubPatCapabilityReport): {
  blocking: GitHubPatCapability[]
  advisory: GitHubPatCapability[]
} {
  const missing = GITHUB_PAT_CAPABILITIES.filter((c) => report.capabilities[c] === 'missing')
  const isBlocking = (c: GitHubPatCapability): boolean =>
    (GITHUB_PAT_BLOCKING_CAPABILITIES as readonly GitHubPatCapability[]).includes(c)
  return { blocking: missing.filter(isBlocking), advisory: missing.filter((c) => !isBlocking(c)) }
}

/**
 * Whether a check warrants interrupting the user with a banner.
 *
 * True for a rejected token and for any established BLOCKING gap. False for `probe_failed` (an
 * outage is not a permissions problem), for `not_applicable`, and for a report whose only
 * findings are advisory or `unknown` — those are visible in the settings surface, where someone
 * who came to look at the connection can act on them, rather than over the board.
 */
export function githubPatCheckNeedsAttention(check: GitHubPatCheck): boolean {
  if (check.state === 'token_rejected') return true
  if (check.state !== 'checked') return false
  return missingGitHubPatCapabilities(check.report).blocking.length > 0
}
