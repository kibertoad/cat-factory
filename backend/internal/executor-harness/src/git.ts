import { execFile } from 'node:child_process'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { BootstrapTargetSpec, PrSpec, RepoSpec } from './job.js'

const exec = promisify(execFile)

// Git + GitHub helpers. The installation token is NEVER placed in a clone/remote
// URL or in any git argv. Instead git authenticates over HTTPS via a GIT_ASKPASS
// helper: the plain `https://x-access-token@host/...` remote (username only, no
// secret) is used everywhere, and the token is handed to git out-of-band through
// an environment variable the helper reads. That keeps the token out of process
// listings and out of any command string Node echoes into an error/cmd field.

const GIT_AUTHOR = 'cat-factory[bot]'
const GIT_EMAIL = 'cat-factory[bot]@users.noreply.github.com'

// Per-git-command wall-clock ceiling. A single git op (clone/push over a flaky
// network) must not hang the job indefinitely; the job's overall watchdog
// (see runner.ts) is the outer bound, this stops one wedged command first.
const GIT_TIMEOUT_MS = 10 * 60_000

/**
 * Strip credentials out of any string before it is logged or stored. Removes
 * URL userinfo (`https://user:pass@host`) and `x-access-token:<token>` patterns,
 * plus bare GitHub token shapes (`ghs_`/`ghp_`/`github_pat_`), so a leaked clone
 * URL or git error can never surface the installation token. Idempotent.
 */
export function redactSecrets(input: string): string {
  return input
    .replace(/(https?:\/\/)[^@\s/]*@/gi, '$1***@')
    .replace(/x-access-token:[^@\s]+/gi, 'x-access-token:***')
    .replace(/\b(gh[pso]_|github_pat_)[A-Za-z0-9_]+/g, '$1***')
}

/** Wrap an error so its message/stack carry no credentials. */
function redactError(err: unknown): Error {
  if (err instanceof Error) {
    const redacted = new Error(redactSecrets(err.message))
    if (err.stack) redacted.stack = redactSecrets(err.stack)
    return redacted
  }
  return new Error(redactSecrets(String(err)))
}

/**
 * Build the remote URL git uses. Only the username (`x-access-token`) is embedded
 * — never the token — so the token never appears in argv. The token is supplied
 * separately via {@link authEnv} and read by the GIT_ASKPASS helper.
 */
export function authenticatedCloneUrl(cloneUrl: string): string {
  // https://github.com/owner/name.git → https://x-access-token@github.com/...
  // (no secret in the URL). file:// and other local URLs are left untouched.
  return cloneUrl.replace(/^https:\/\//, 'https://x-access-token@')
}

// A tiny askpass helper that prints the token git asks for. Created once per
// process and reused; the token itself is passed per-command via the env (below),
// never baked into the script.
let askpassPathPromise: Promise<string> | undefined
function ensureAskpass(): Promise<string> {
  askpassPathPromise ??= (async () => {
    const dir = await mkdtemp(join(tmpdir(), 'git-askpass-'))
    const path = join(dir, 'askpass.sh')
    // git invokes this with the prompt as argv[1]; we only ever return the token
    // (the username is already in the remote URL, so git only asks for the
    // password). The token comes from the env, never from argv.
    await writeFile(path, '#!/bin/sh\nexec printf %s "$GIT_ASKPASS_TOKEN"\n', 'utf8')
    await chmod(path, 0o700)
    return path
  })()
  return askpassPathPromise
}

/** Child-process env that lets git authenticate with `ghToken` without it touching argv. */
async function authEnv(ghToken: string): Promise<NodeJS.ProcessEnv> {
  return {
    ...process.env,
    GIT_ASKPASS: await ensureAskpass(),
    GIT_ASKPASS_TOKEN: ghToken,
    // Never fall back to an interactive prompt (which would hang the job).
    GIT_TERMINAL_PROMPT: '0',
  }
}

/**
 * Run one git command. `signal` (the job watchdog's) and a per-command timeout
 * both abort a wedged process, so neither a hung clone nor a stalled push can
 * keep the container running forever. Any failure is re-thrown with its message
 * and stack scrubbed of credentials.
 */
async function git(
  args: string[],
  opts: { cwd?: string; signal?: AbortSignal; env?: NodeJS.ProcessEnv } = {},
): Promise<string> {
  try {
    const { stdout } = await exec('git', args, {
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      maxBuffer: 16 * 1024 * 1024,
      timeout: GIT_TIMEOUT_MS,
      ...(opts.env ? { env: opts.env } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    })
    return stdout
  } catch (err) {
    throw redactError(err)
  }
}

/** Clone `repo`'s base branch (shallow by default) into `dir` and set commit identity. */
export async function cloneRepo(opts: {
  repo: RepoSpec
  ghToken: string
  dir: string
  signal?: AbortSignal
  /**
   * Full history + all remote-tracking branches. A shallow single-branch clone is
   * enough to implement on one branch, but merging ANOTHER branch in (the
   * conflict-resolver) needs the merge base in history and `origin/<other>` present
   * — so `full` drops both `--depth 1` (which implies `--single-branch`).
   */
  full?: boolean
}): Promise<void> {
  const url = authenticatedCloneUrl(opts.repo.cloneUrl)
  const cloneArgs = opts.full
    ? ['clone', '--branch', opts.repo.baseBranch, url, opts.dir]
    : ['clone', '--depth', '1', '--branch', opts.repo.baseBranch, url, opts.dir]
  await git(cloneArgs, { signal: opts.signal, env: await authEnv(opts.ghToken) })
  await git(['config', 'user.name', GIT_AUTHOR], { cwd: opts.dir, signal: opts.signal })
  await git(['config', 'user.email', GIT_EMAIL], { cwd: opts.dir, signal: opts.signal })
}

/** Create and switch to the work branch. */
export async function createBranch(
  dir: string,
  branch: string,
  signal?: AbortSignal,
): Promise<void> {
  await git(['checkout', '-b', branch], { cwd: dir, signal })
}

/**
 * Whether `branch` already exists on the remote — i.e. an earlier (possibly
 * evicted) run of this task already pushed work to it, so a re-dispatch should
 * RESUME on it (clone it, continue on its commits) rather than branch off base and
 * start over. Uses `git ls-remote` (no checkout); the token is supplied out of band.
 */
export async function remoteBranchExists(
  cloneUrl: string,
  branch: string,
  ghToken: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const url = authenticatedCloneUrl(cloneUrl)
  const out = await git(['ls-remote', '--heads', url, branch], {
    signal,
    env: await authEnv(ghToken),
  })
  return out.trim() !== ''
}

/**
 * Clone an EXISTING work branch (full history) into `dir` and check it out — used
 * to resume a task whose earlier run already pushed commits to this branch, so the
 * agent continues on top of that work instead of redoing it.
 */
export async function cloneExistingBranch(opts: {
  cloneUrl: string
  branch: string
  ghToken: string
  dir: string
  signal?: AbortSignal
}): Promise<void> {
  const url = authenticatedCloneUrl(opts.cloneUrl)
  await git(['clone', '--branch', opts.branch, '--single-branch', url, opts.dir], {
    signal: opts.signal,
    env: await authEnv(opts.ghToken),
  })
  await git(['config', 'user.name', GIT_AUTHOR], { cwd: opts.dir, signal: opts.signal })
  await git(['config', 'user.email', GIT_EMAIL], { cwd: opts.dir, signal: opts.signal })
}

/**
 * Commit edits the agent left UNCOMMITTED — but only to files git already tracks
 * (`git add -u`), never new untracked files. The agent owns commit selection (it
 * alone knows which new files are part of the solution vs scratch scripts/artifacts
 * it created while exploring), so this is just a safety net that captures forgotten
 * edits to existing files without ever sweeping in junk a blanket `git add -A`
 * would. Returns false when there was nothing tracked to commit.
 */
export async function commitTrackedEdits(
  dir: string,
  message: string,
  signal?: AbortSignal,
): Promise<boolean> {
  await git(['add', '-u'], { cwd: dir, signal })
  // Only consider staged (tracked) changes — untracked files are deliberately ignored.
  const staged = await git(['diff', '--cached', '--name-only'], { cwd: dir, signal })
  if (staged.trim() === '') return false
  await git(['commit', '-m', message], { cwd: dir, signal })
  return true
}

/** Whether the branch advanced past `baseSha` via commits (the agent's own + any safety-net commit). */
export async function branchHasCommitsSince(
  dir: string,
  baseSha: string,
  signal?: AbortSignal,
): Promise<boolean> {
  return (await headCommit(dir, signal)) !== baseSha
}

/**
 * Parse the paths out of `git status --porcelain` (v1) output. Each line is
 * `XY <path>`, or `XY <old> -> <new>` for a rename/copy (we keep the new path);
 * git quotes paths with special characters, which we unquote. Blank lines are
 * skipped. Pure so the no-op detection can be tested without spawning git.
 */
export function changedPathsFromPorcelain(status: string): string[] {
  const paths: string[] = []
  for (const raw of status.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (line.trim() === '') continue
    let path = line.slice(3)
    const arrow = path.indexOf(' -> ')
    if (arrow !== -1) path = path.slice(arrow + 4)
    path = path.trim().replace(/^"(.*)"$/, '$1')
    if (path) paths.push(path)
  }
  return paths
}

/**
 * Whether the agent changed anything in a cloned checkout, ignoring the
 * harness-written `AGENTS.md`. Stages the working tree and inspects the porcelain
 * status: an empty result (or one holding only AGENTS.md) means the bootstrapper
 * made no adaptation — a no-op we must not pass off as a successful push.
 */
export async function hasAgentChanges(dir: string, signal?: AbortSignal): Promise<boolean> {
  await git(['add', '-A'], { cwd: dir, signal })
  const status = await git(['status', '--porcelain'], { cwd: dir, signal })
  return changedPathsFromPorcelain(status).some((path) => path.toLowerCase() !== 'agents.md')
}

/** The commit SHA at `dir`'s HEAD — captured right after clone as the base tip. */
export async function headCommit(dir: string, signal?: AbortSignal): Promise<string> {
  return (await git(['rev-parse', 'HEAD'], { cwd: dir, signal })).trim()
}

/**
 * Whether the work branch produced any real change relative to `baseSha` (the base
 * branch tip captured right after clone). Crucially this counts the agent's OWN
 * commits as well as any still-uncommitted edits — the build role tells the agent
 * to commit its work itself, so by the end of a successful run the working tree is
 * often clean and a trailing {@link commitAll} finds nothing even though the branch
 * advanced. Judging the *whole run* against the base tip (and ignoring the
 * harness-written AGENTS.md, as {@link hasAgentChanges} does) is what tells a
 * genuine no-op — the agent never wrote anything — apart from a real run whose
 * changes are already committed. Stages first so newly created files are visible.
 */
export async function branchHasChanges(
  dir: string,
  baseSha: string,
  signal?: AbortSignal,
): Promise<boolean> {
  await git(['add', '-A'], { cwd: dir, signal })
  const diff = await git(['diff', '--name-only', baseSha], { cwd: dir, signal })
  return diff
    .split('\n')
    .map((line) =>
      line
        .replace(/\r$/, '')
        .trim()
        .replace(/^"(.*)"$/, '$1'),
    )
    .some((path) => path !== '' && path.toLowerCase() !== 'agents.md')
}

/** Stage everything and commit; returns false when there was nothing to commit. */
export async function commitAll(
  dir: string,
  message: string,
  signal?: AbortSignal,
): Promise<boolean> {
  await git(['add', '-A'], { cwd: dir, signal })
  const status = await git(['status', '--porcelain'], { cwd: dir, signal })
  if (status.trim() === '') return false
  await git(['commit', '-m', message], { cwd: dir, signal })
  return true
}

/** Paths git still reports as unmerged (conflict stage entries) in the working tree. */
export async function unmergedPaths(dir: string, signal?: AbortSignal): Promise<string[]> {
  const out = await git(['diff', '--name-only', '--diff-filter=U'], { cwd: dir, signal })
  return out
    .split('\n')
    .map((line) =>
      line
        .replace(/\r$/, '')
        .trim()
        .replace(/^"(.*)"$/, '$1'),
    )
    .filter((path) => path !== '')
}

/**
 * Merge `origin/<baseBranch>` into the current branch (no fast-forward squash, no
 * editor). Returns `true` for a clean merge (or an already-up-to-date no-op) and
 * `false` when the merge left conflicts in the working tree — the expected case the
 * conflict-resolver agent then fixes, NOT an error. Any other git failure (e.g. an
 * unknown ref) is re-thrown. Requires a {@link cloneRepo} with `full: true` so the
 * merge base and `origin/<baseBranch>` are present.
 */
export async function mergeBranch(
  dir: string,
  baseBranch: string,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    await git(['merge', '--no-edit', `origin/${baseBranch}`], { cwd: dir, signal })
    return true
  } catch (err) {
    // A merge conflict exits non-zero and leaves unmerged paths; distinguish it
    // from a genuine failure (which leaves none) so only real errors propagate.
    if ((await unmergedPaths(dir, signal)).length > 0) return false
    throw err
  }
}

/**
 * Push the work branch to origin. The remote URL carries only the username, so
 * the token is supplied here via the askpass env (never in argv).
 */
export async function pushBranch(
  dir: string,
  branch: string,
  ghToken: string,
  signal?: AbortSignal,
): Promise<void> {
  await git(['push', '-u', 'origin', branch], {
    cwd: dir,
    signal,
    env: await authEnv(ghToken),
  })
}

/**
 * Reset the working tree's git history to a single bootstrap commit and push it
 * to the target repository's default branch. Wiping `.git` before re-initialising
 * means the new repo starts clean — it inherits the bootstrapped *contents* of the
 * reference architecture, not its commit history.
 *
 * The push is forced: the fresh single-commit history shares no ancestor with
 * whatever GitHub prepopulated when the user created the repo (a README,
 * .gitignore and/or license picked on the new-repo page), so a fast-forward is
 * impossible. The Worker pre-flights that the target is empty or holds only that
 * boilerplate, so overwriting it is safe and intended.
 */
export async function reinitAndPush(opts: {
  dir: string
  target: BootstrapTargetSpec
  ghToken: string
  message: string
}): Promise<void> {
  await rm(join(opts.dir, '.git'), { recursive: true, force: true })
  await git(['init'], { cwd: opts.dir })
  // Start the history on the target's default branch (init may default to master).
  await git(['checkout', '-b', opts.target.defaultBranch], { cwd: opts.dir })
  await git(['config', 'user.name', GIT_AUTHOR], { cwd: opts.dir })
  await git(['config', 'user.email', GIT_EMAIL], { cwd: opts.dir })
  await git(['add', '-A'], { cwd: opts.dir })
  await git(['commit', '-m', opts.message], { cwd: opts.dir })
  const url = authenticatedCloneUrl(opts.target.cloneUrl)
  await git(['remote', 'add', 'origin', url], { cwd: opts.dir })
  await git(['push', '--force', '-u', 'origin', opts.target.defaultBranch], {
    cwd: opts.dir,
    env: await authEnv(opts.ghToken),
  })
}

/** Open a PR via the GitHub REST API; returns its html_url. */
export async function openPullRequest(opts: {
  owner: string
  name: string
  ghToken: string
  head: string
  base: string
  pr: PrSpec
  apiBase?: string
  signal?: AbortSignal
}): Promise<string> {
  const apiBase = opts.apiBase ?? 'https://api.github.com'
  const res = await fetch(`${apiBase}/repos/${opts.owner}/${opts.name}/pulls`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${opts.ghToken}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'cat-factory-executor',
      'x-github-api-version': '2022-11-28',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      title: opts.pr.title,
      head: opts.head,
      base: opts.base,
      body: opts.pr.body,
    }),
    // Bound on the watchdog so a hung GitHub call can't stall the job.
    ...(opts.signal ? { signal: opts.signal } : {}),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    // A resumed run pushes to a branch that already has an open PR; GitHub answers
    // 422 "A pull request already exists". That's success for us — return the
    // existing PR's url rather than failing the resumed run.
    if (res.status === 422 && /pull request already exists/i.test(detail)) {
      const existing = await findOpenPullRequestUrl(opts)
      if (existing) return existing
    }
    throw new Error(
      redactSecrets(`Failed to open PR (HTTP ${res.status}): ${detail.slice(0, 300)}`),
    )
  }
  const body = (await res.json()) as { html_url?: string }
  if (!body.html_url) throw new Error('GitHub did not return a PR url')
  return body.html_url
}

/** Find the open PR for `opts.head` on `opts.base`, returning its html_url or undefined. */
async function findOpenPullRequestUrl(opts: {
  owner: string
  name: string
  ghToken: string
  head: string
  base: string
  apiBase?: string
  signal?: AbortSignal
}): Promise<string | undefined> {
  const apiBase = opts.apiBase ?? 'https://api.github.com'
  const query = `head=${opts.owner}:${opts.head}&base=${opts.base}&state=open`
  const res = await fetch(`${apiBase}/repos/${opts.owner}/${opts.name}/pulls?${query}`, {
    headers: {
      authorization: `Bearer ${opts.ghToken}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'cat-factory-executor',
      'x-github-api-version': '2022-11-28',
    },
    ...(opts.signal ? { signal: opts.signal } : {}),
  })
  if (!res.ok) return undefined
  const list = (await res.json().catch(() => [])) as Array<{ html_url?: string }>
  return Array.isArray(list) && list[0]?.html_url ? list[0].html_url : undefined
}
