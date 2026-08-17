// What only THIS suite knows about writing its own `.env`: which of its variables are secret, and
// where an operator goes to create the two things it cannot create for them.
//
// The MERGE itself is `@cat-factory/cli`'s (`envMerge.ts`), beside the `renderEnvFile` it completes.
// It used to live here, and the five judgements in it are provider-neutral and suite-neutral to the
// last line: keeping unmanaged content verbatim, the four-way report, quoting a value the reader
// would otherwise disagree about, recognising the carried-over header, and withholding rather than
// masking. Each is a SILENT failure when wrong (the command reports success and the file means
// something else), which is exactly the kind of thing a consumer should not have to re-derive.
//
// What stayed is what a shared module could not know: the secret LIST (only a suite knows its own)
// and the two creation links.

import type { PrReportRunProvider } from '@cat-factory/sdk'

/**
 * The variables whose VALUE must never be printed, listed rather than pattern-matched.
 *
 * A `key.includes('TOKEN')` test would pass today and quietly stop covering the next secret whose
 * name does not say so, and the failure is one nobody sees: a token on someone's scrollback. Handed
 * to `describeEntries`, which owns the withholding and deliberately does not own this list.
 */
export const SECRET_KEYS: ReadonlySet<string> = new Set([
  'CAT_FACTORY_API_KEY',
  'ACCEPTANCE_K3S_TOKEN',
  'ACCEPTANCE_VCS_TOKEN',
])

/**
 * Where the operator creates a repository, prefilled, or null when this platform cannot say.
 *
 * A `Record` over the provider union the public API reports, so a third provider fails to compile
 * here rather than silently taking GitHub's link. GitLab answers NULL on purpose: a project
 * creation form takes no name parameter, and `GET /api/v1/vcs/connection` publishes no instance
 * URL, so the only link this code could build is `gitlab.com`, which for a self-hosted deployment
 * is a stranger's server. CLAUDE.md's rule for exactly this ("null ⇒ WITHHOLD the affordance,
 * never fall back to the public instance") is why the caller prints instructions instead.
 *
 * The GitHub link carries the same residual caveat, which is why the caller PRINTS it before
 * opening it: an Enterprise Server host is not knowable from `/api/v1` either, and an operator who
 * sees `github.com` and is not on it can ignore the offer.
 */
export const REPO_CREATION_URL: Record<
  PrReportRunProvider,
  (owner: string, name: string) => string | null
> = {
  github: (owner, name) => {
    const url = new URL('https://github.com/new')
    url.searchParams.set('name', name)
    url.searchParams.set('owner', owner)
    url.searchParams.set('visibility', 'private')
    return url.href
  },
  gitlab: () => null,
}

/**
 * Where the operator mints the REPORTER token, prefilled, or null when this platform cannot say.
 *
 * The sibling of {@link REPO_CREATION_URL}, and the same `Record` over the provider union for the
 * same reason: a third provider fails to compile here rather than sending someone to GitHub's
 * settings for a token their host has never heard of.
 *
 * GitHub's CLASSIC token form takes `description` and `scopes` as query parameters, which is what
 * makes a prefilled link possible at all: the fine-grained form
 * (`/settings/personal-access-tokens/new`) accepts neither, so a link to it would be a link to an
 * empty page with the choices still to make. A fine-grained token IS the better credential here
 * (Issues read+write on one repository, versus classic `repo` across everything the account can
 * see), so the caller offers this link and says that in the same breath rather than either choosing
 * for the operator or pretending the narrow option cannot be prefilled for a reason of ours.
 *
 * `repo` and not `public_repo`: a private target repository is the normal case for an acceptance
 * pass, and `public_repo` cannot see one at all. GitLab is null for the reason its repository link
 * is (`vcsIssues.ts` states it): nothing publishes which instance to send the operator to.
 */
export const REPORTER_TOKEN_URL: Record<PrReportRunProvider, (note: string) => string | null> = {
  github: (note) => {
    const url = new URL('https://github.com/settings/tokens/new')
    url.searchParams.set('description', note)
    url.searchParams.set('scopes', 'repo')
    return url.href
  },
  gitlab: () => null,
}
