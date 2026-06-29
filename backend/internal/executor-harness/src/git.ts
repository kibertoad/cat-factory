import { execFile } from 'node:child_process'
import { appendFile, chmod, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { BootstrapTargetSpec, PrSpec, RepoSpec } from './job.js'
import { redactSecrets } from './redact.js'
import { loadRunnerLimits } from './runner.js'

// Re-exported so existing importers that pull `redactSecrets` from this module keep
// working; the single source of truth now lives in ./redact.js.
export { redactSecrets } from './redact.js'

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
//
// INVARIANT: this MUST stay STRICTLY BELOW the inactivity watchdog
// (`RunnerLimits.inactivityMs`). Git emits no Pi activity events while it runs, so a
// slow clone/push races both timers; if they were equal the job could fail with the
// misleading "no agent activity … likely hung" instead of a clear "git timed out".
// Staying under that window means git always loses the race and surfaces its own
// accurate reason.
//
// Rather than hardcode a constant against the *default* watchdog (which silently
// breaks the invariant when an operator lowers `JOB_INACTIVITY_MS`), we DERIVE the
// ceiling from the actually-configured window: a fixed margin below it, floored so a
// tiny window can't yield a non-positive timeout. At the 10-min default this resolves
// to the same 7 min as before; at a lowered 5-min window it tracks down to 2 min.
const GIT_TIMEOUT_MARGIN_MS = 3 * 60_000
const GIT_TIMEOUT_FLOOR_MS = 60_000
const GIT_TIMEOUT_MS = Math.max(
  GIT_TIMEOUT_FLOOR_MS,
  loadRunnerLimits().inactivityMs - GIT_TIMEOUT_MARGIN_MS,
)

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

/** Drop any `user[:pass]@` userinfo from a URL so two clone URLs can be compared by repo. */
function withoutUserinfo(url: string): string {
  return url.replace(/^([a-z]+:\/\/)[^@/]*@/i, '$1')
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

/** Whether `path` exists (a file or directory). */
async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * The directory-name globs the clean sweep PRESERVES — dependency caches that are
 * expensive to rebuild (node_modules, language toolchain caches). Keeping them is the
 * whole point of reusing a checkout: a `git clean -ffdx` would otherwise wipe them and
 * force a reinstall every run. Configurable via `HARNESS_CLEAN_KEEP` (comma-separated).
 */
export function cleanKeepPatterns(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.HARNESS_CLEAN_KEEP ?? 'node_modules,.venv,target,.gradle,.pnpm-store'
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
}

/**
 * Reset a REUSED checkout to a pristine state before the next job runs in it: hard-reset
 * tracked files and remove every untracked/ignored file EXCEPT the preserved dependency
 * caches (see {@link cleanKeepPatterns}). This is what guarantees a prior run's garbage —
 * stray scratch files, half-written edits, stale build output — never contaminates the
 * next run that reuses the same persistent checkout. A fresh clone never needs it.
 *
 * Submodules: when `.gitmodules` is present we use a single `-f` (which makes `git clean`
 * skip nested git repositories, i.e. the submodule worktrees) and reset/refresh the
 * submodules explicitly; otherwise `-ff` also nukes any stray nested repo the agent left.
 */
export async function cleanSweep(
  dir: string,
  ghToken: string,
  signal?: AbortSignal,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await git(['reset', '--hard'], { cwd: dir, signal })
  const hasSubmodules = await pathExists(join(dir, '.gitmodules'))
  if (hasSubmodules) {
    await git(['submodule', 'foreach', '--recursive', 'git reset --hard'], {
      cwd: dir,
      signal,
    }).catch(() => {})
  }
  const keep = cleanKeepPatterns(env).flatMap((p) => ['-e', p])
  // `-ffdx` (or `-fdx` with submodules) removes untracked + ignored files and dirs; the
  // `-e` excludes keep the dependency caches. Tracked files were already hard-reset above.
  await git(['clean', hasSubmodules ? '-fdx' : '-ffdx', ...keep], { cwd: dir, signal })
  if (hasSubmodules) {
    await git(['submodule', 'update', '--init', '--recursive'], {
      cwd: dir,
      signal,
      env: await authEnv(ghToken),
    }).catch(() => {})
  }
}

/**
 * The `origin` remote URL (without credentials) of the checkout at `dir`, or undefined
 * when it isn't a git repo / has no origin. Used to detect a persistent checkout dir that
 * somehow holds a DIFFERENT repo than the one we're about to prepare (it never should —
 * the dir is keyed per repo — but a stale dir from a prior layout would be a silent
 * cross-repo bleed, so we re-clone rather than reuse).
 */
export async function checkoutRemoteUrl(
  dir: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  try {
    return (await git(['remote', 'get-url', 'origin'], { cwd: dir, signal })).trim() || undefined
  } catch {
    return undefined
  }
}

/**
 * Prepare a REUSED (persistent) checkout at `dir` so the agent runs against a clean tree
 * on the right branch — the persistent-checkout analogue of {@link cloneRepo} +
 * {@link cloneExistingBranch}. On the FIRST use of a per-repo dir there's no `.git` yet, so
 * it clones once (full history, so a later merger/conflict step reusing the dir can diff
 * against the base); afterwards it reuses the dir in place: clean sweep → re-point origin →
 * fetch → check out `branch`. When `existing` is true `branch` is fetched and checked out
 * directly (resume / base branch); otherwise `branch` is (re)created off `baseBranch`'s tip
 * (a fresh work branch). Only the local transport sets `persistentCheckout`, so every other
 * runtime keeps the fresh-clone path untouched.
 */
export async function prepareExistingCheckout(opts: {
  dir: string
  repo: RepoSpec
  ghToken: string
  /** The branch to end up checked out on. */
  branch: string
  /** Base branch to (re)create `branch` off when `existing` is false; also fetched for history. */
  baseBranch: string
  /** Whether `branch` already exists on the remote (resume / base) — checkout it directly. */
  existing: boolean
  signal?: AbortSignal
}): Promise<void> {
  const { dir, repo, ghToken, branch, baseBranch, existing, signal } = opts
  const cloneUrl = authenticatedCloneUrl(repo.cloneUrl)

  // First use of this per-repo dir, or a stale dir holding a DIFFERENT repo → clone fresh
  // (full history, so a later merger/conflict step reusing the dir can diff against base).
  const currentRemote = (await pathExists(join(dir, '.git')))
    ? await checkoutRemoteUrl(dir, signal)
    : undefined
  if (!currentRemote || withoutUserinfo(currentRemote) !== withoutUserinfo(cloneUrl)) {
    await rm(dir, { recursive: true, force: true })
    await cloneRepo({ repo: { ...repo, baseBranch }, ghToken, dir, full: true, signal })
  }

  const env = await authEnv(ghToken)
  await cleanSweep(dir, ghToken, signal)
  // Re-point origin in case the stored URL drifted (idempotent; carries no secret).
  await git(['remote', 'set-url', 'origin', cloneUrl], { cwd: dir, signal })
  const fetchRef = existing ? branch : baseBranch
  // Fetch the target ref AND the base into their tracking refs in ONE command, with explicit
  // destination refspecs. The checkout below then reads `origin/<fetchRef>` directly rather
  // than FETCH_HEAD: FETCH_HEAD only ever holds the LAST fetched ref, so a second base fetch
  // would clobber it and a resumed work branch (base != branch) would be reset to the BASE
  // tip — silently discarding the resumed commits. Keeping `origin/<baseBranch>` fresh also
  // matters for the downstream merger/diff; a missing base diverges from a fresh full clone,
  // so this is NOT best-effort (a failure surfaces rather than leaving a stale base ref).
  const refspecs = [`+${fetchRef}:refs/remotes/origin/${fetchRef}`]
  if (baseBranch !== fetchRef) refspecs.push(`+${baseBranch}:refs/remotes/origin/${baseBranch}`)
  await git(['fetch', 'origin', ...refspecs], { cwd: dir, signal, env })
  // `-f`: the clean sweep deliberately PRESERVES dependency caches (node_modules/target/…)
  // as untracked files; if one collides with a path the target branch TRACKS, a plain
  // checkout aborts ("untracked working tree files would be overwritten"). Force overwrites
  // only the in-the-way files, leaving the other kept caches intact.
  await git(['checkout', '-f', '-B', branch, `refs/remotes/origin/${fetchRef}`], {
    cwd: dir,
    signal,
  })
  await git(['config', 'user.name', GIT_AUTHOR], { cwd: dir, signal })
  await git(['config', 'user.email', GIT_EMAIL], { cwd: dir, signal })
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

/**
 * The untracked, non-ignored files left in the working tree (`git ls-files --others
 * --exclude-standard`). The harness deliberately never blanket-stages new files (the
 * agent owns commit selection), so this is exactly what {@link commitTrackedEdits}
 * does NOT capture — a NEW file the agent created but forgot to commit. The caller
 * surfaces it as a warning so that silent loss is at least observable in the logs.
 */
export async function listUntrackedFiles(dir: string, signal?: AbortSignal): Promise<string[]> {
  const out = await git(['ls-files', '--others', '--exclude-standard'], { cwd: dir, signal })
  return out
    .split('\n')
    .map((line) => line.replace(/\r$/, '').trim())
    .filter((path) => path !== '')
}

/**
 * Locally exclude `pattern` from this checkout via `.git/info/exclude` — a per-clone
 * ignore that never lands in the repo (unlike a `.gitignore`). Used for the harness's
 * follow-up sentinel file so the agent's own `git add` can never stage it and it never
 * surfaces as an untracked-leftover warning or in the PR. Best-effort: a failure here
 * just means the sentinel might show as untracked (logged, not pushed), never fatal.
 */
export async function excludeFromGit(
  dir: string,
  pattern: string,
  signal?: AbortSignal,
): Promise<void> {
  try {
    const excludePath = join(dir, '.git', 'info', 'exclude')
    await appendFile(excludePath, `\n${pattern}\n`, 'utf8')
  } catch {
    // A missing .git/info/exclude (worktree layout) or write error is non-fatal.
    void signal
  }
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
 * Whether the checked-out branch has a real, examinable diff against
 * `origin/<baseBranch>` — i.e. the base branch's remote-tracking ref exists (so the
 * merge base resolves) AND there are changes between that merge base and HEAD. The
 * merger uses this to refuse to score a PR it could not actually inspect (a missing
 * base ref or an empty diff) instead of emitting bogus low scores that would
 * auto-merge. Returns false on ANY git error (e.g. an unknown ref). Requires a
 * {@link cloneRepo} with `full: true` so `origin/<baseBranch>` and the merge base exist.
 */
export async function hasDiffAgainstBase(
  dir: string,
  baseBranch: string,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    const stat = await git(['diff', '--stat', `origin/${baseBranch}...HEAD`], { cwd: dir, signal })
    return stat.trim() !== ''
  } catch {
    return false
  }
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
 * Whether the agent changed anything in a cloned checkout. Stages the working
 * tree and inspects the porcelain status: an empty result means the bootstrapper
 * made no adaptation — a no-op we must not pass off as a successful push. (The
 * harness writes its prompt context to Pi's global `~/.pi/agent/AGENTS.md`, never
 * into the checkout, so every change reported here is a genuine agent edit.)
 */
export async function hasAgentChanges(dir: string, signal?: AbortSignal): Promise<boolean> {
  await git(['add', '-A'], { cwd: dir, signal })
  const status = await git(['status', '--porcelain'], { cwd: dir, signal })
  return changedPathsFromPorcelain(status).length > 0
}

/** The commit SHA at `dir`'s HEAD — captured right after clone as the base tip. */
export async function headCommit(dir: string, signal?: AbortSignal): Promise<string> {
  return (await git(['rev-parse', 'HEAD'], { cwd: dir, signal })).trim()
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
 * The conflict hunks for the given unmerged `paths`: `git diff` over exactly those
 * files, which for an unmerged entry renders the combined diff carrying the
 * `<<<<<<<` / `=======` / `>>>>>>>` markers each side contributed. Handed to the
 * conflict-resolver agent so it sees the actual conflicts instead of having to
 * rediscover them. Capped to `maxChars` total (a note is appended on truncation) so a
 * huge conflict can't blow up the prompt. Returns '' when there are no paths.
 */
export async function conflictDiff(
  dir: string,
  paths: string[],
  signal?: AbortSignal,
  maxChars = 24_000,
): Promise<string> {
  if (paths.length === 0) return ''
  const out = await git(['diff', '--', ...paths], { cwd: dir, signal })
  if (out.length <= maxChars) return out
  return `${out.slice(0, maxChars)}\n\n[diff truncated at ${maxChars} characters — open the files directly to see the remaining conflicts]`
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
 * Bring a RESUMED work branch up to the latest `baseBranch` when (and only when) the
 * two merge cleanly. A resumed branch was cut from an older base, so without this the
 * agent continues against a stale base and the eventual PR can carry avoidable
 * conflicts. Fetches the base (the single-branch resume clone doesn't have it),
 * attempts `git merge --no-edit`, and on a conflict ABORTS — leaving the branch
 * exactly as it was so the run proceeds on the stale base (the CI/merge gate handles
 * a genuinely conflicting PR downstream, as before). Returns whether base was merged
 * in. Best-effort: callers treat a thrown/false result as "continue without refresh".
 */
export async function refreshFromBaseIfClean(
  dir: string,
  baseBranch: string,
  ghToken: string,
  signal?: AbortSignal,
): Promise<boolean> {
  await git(['fetch', 'origin', baseBranch], { cwd: dir, signal, env: await authEnv(ghToken) })
  try {
    await git(['merge', '--no-edit', 'FETCH_HEAD'], { cwd: dir, signal })
    return true
  } catch (err) {
    if ((await unmergedPaths(dir, signal)).length > 0) {
      // Conflict — undo the half-done merge and keep the branch on its old base.
      await git(['merge', '--abort'], { cwd: dir, signal }).catch(() => {})
      return false
    }
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

export interface OpenPullRequestOptions {
  owner: string
  name: string
  ghToken: string
  head: string
  base: string
  pr: PrSpec
  apiBase?: string
  /**
   * The repo's clone URL. Used (when {@link provider} is absent) to detect the provider and,
   * for GitLab, to derive the REST base + project path from its host — so the harness opens a
   * GitLab **merge request** rather than POSTing to GitHub's pulls API. Absent ⇒ GitHub.
   */
  cloneUrl?: string
  /**
   * The VCS provider, when the dispatcher knows it (the server derives it from the configured
   * source-control backend and sets `repo.provider`). AUTHORITATIVE — it overrides host
   * inference — so a self-managed GitLab on an arbitrarily-named host (e.g. `git.acme.com`,
   * which {@link inferVcsProvider} can't recognise) still opens a merge request instead of
   * being misrouted to GitHub's API. Absent ⇒ inferred from {@link cloneUrl}'s host.
   */
  provider?: 'github' | 'gitlab'
  signal?: AbortSignal
}

/**
 * The VCS host a clone URL points at. The harness is otherwise provider-agnostic (its git
 * auth is a host-neutral GIT_ASKPASS credential), but the "open the PR/MR" REST call is not:
 * GitHub and GitLab have different endpoints, so infer which to call from the host. GitHub is
 * the default; a host of `gitlab.com` or one in the `gitlab.*` / `*.gitlab.*` family (covering
 * self-managed instances named that way) is treated as GitLab.
 */
export function inferVcsProvider(cloneUrl: string): 'github' | 'gitlab' {
  let host = ''
  try {
    host = new URL(cloneUrl).host.toLowerCase()
  } catch {
    return 'github'
  }
  if (host === 'gitlab.com' || host.startsWith('gitlab.') || host.includes('.gitlab.')) {
    return 'gitlab'
  }
  return 'github'
}

/** The GitLab REST v4 base for a clone URL's host, e.g. `https://gitlab.com/api/v4`. */
export function gitlabApiBaseFromCloneUrl(cloneUrl: string): string {
  const u = new URL(cloneUrl)
  return `${u.protocol}//${u.host}/api/v4`
}

/**
 * The URL-encoded GitLab project path from a clone URL — the full namespace path (so subgroups
 * survive), with the trailing `.git` stripped, e.g.
 * `https://gitlab.com/group/sub/proj.git` → `group%2Fsub%2Fproj`.
 */
export function gitlabProjectPath(cloneUrl: string): string {
  const path = new URL(cloneUrl).pathname.replace(/^\/+/, '').replace(/\.git$/, '')
  return encodeURIComponent(path)
}

/**
 * Open a PR (GitHub) or merge request (GitLab) for the pushed branch; returns its web URL.
 * The provider is chosen from the EXPLICIT `opts.provider` when the dispatcher set it,
 * falling back to host inference from the clone URL only when it didn't — so a self-managed
 * GitLab whose host isn't named `gitlab.*` still opens an MR instead of being misrouted to
 * GitHub's API. The GitHub path is unchanged.
 */
export async function openPullRequest(opts: OpenPullRequestOptions): Promise<string> {
  const provider = opts.provider ?? (opts.cloneUrl ? inferVcsProvider(opts.cloneUrl) : 'github')
  if (provider === 'gitlab') {
    if (!opts.cloneUrl) {
      throw new Error('Cannot open a GitLab merge request without the repo clone URL')
    }
    return openGitLabMergeRequest({ ...opts, cloneUrl: opts.cloneUrl })
  }
  const apiBase = opts.apiBase ?? 'https://api.github.com'
  const path = `${encodeURIComponent(opts.owner)}/${encodeURIComponent(opts.name)}`
  const res = await fetch(`${apiBase}/repos/${path}/pulls`, {
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

/** GitLab API headers for the PAT (the `PRIVATE-TOKEN` auth GitLab uses). */
function gitlabHeaders(token: string): Record<string, string> {
  return {
    'private-token': token,
    accept: 'application/json',
    'user-agent': 'cat-factory-executor',
    'content-type': 'application/json',
  }
}

/**
 * Open a GitLab merge request (the analogue of {@link openPullRequest} for GitLab). The REST
 * base + project path are derived from the clone URL's host, so it works for gitlab.com and a
 * self-managed instance alike. `head`→`source_branch`, `base`→`target_branch`. On a duplicate
 * (a resumed run whose branch already has an open MR — GitLab answers 409) the existing MR's
 * web URL is returned instead of failing the run, mirroring the GitHub 422 handling.
 */
async function openGitLabMergeRequest(
  opts: OpenPullRequestOptions & { cloneUrl: string },
): Promise<string> {
  const apiBase = gitlabApiBaseFromCloneUrl(opts.cloneUrl)
  const project = gitlabProjectPath(opts.cloneUrl)
  const res = await fetch(`${apiBase}/projects/${project}/merge_requests`, {
    method: 'POST',
    headers: gitlabHeaders(opts.ghToken),
    body: JSON.stringify({
      source_branch: opts.head,
      target_branch: opts.base,
      title: opts.pr.title,
      description: opts.pr.body,
    }),
    ...(opts.signal ? { signal: opts.signal } : {}),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    // GitLab returns 409 (sometimes 400) when an open MR already exists for this source
    // branch; that is success for a resumed run — return the existing MR's url.
    if (
      (res.status === 409 || res.status === 400) &&
      /already exists|open merge request/i.test(detail)
    ) {
      const existing = await findOpenMergeRequestUrl(apiBase, project, opts)
      if (existing) return existing
    }
    throw new Error(
      redactSecrets(`Failed to open merge request (HTTP ${res.status}): ${detail.slice(0, 300)}`),
    )
  }
  const body = (await res.json()) as { web_url?: string }
  if (!body.web_url) throw new Error('GitLab did not return a merge request url')
  return body.web_url
}

/** Find the open GitLab MR for `opts.head`, returning its web_url or undefined. */
async function findOpenMergeRequestUrl(
  apiBase: string,
  project: string,
  opts: { head: string; ghToken: string; signal?: AbortSignal },
): Promise<string | undefined> {
  const query = new URLSearchParams({ source_branch: opts.head, state: 'opened' })
  const res = await fetch(`${apiBase}/projects/${project}/merge_requests?${query}`, {
    headers: gitlabHeaders(opts.ghToken),
    ...(opts.signal ? { signal: opts.signal } : {}),
  })
  if (!res.ok) return undefined
  const list = (await res.json().catch(() => [])) as Array<{ web_url?: string }>
  return Array.isArray(list) && list[0]?.web_url ? list[0].web_url : undefined
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
  // Encode the ref-derived query params: a branch/owner containing `&` or `#` would
  // otherwise split the query string or inject an unintended parameter.
  const query = new URLSearchParams({
    head: `${opts.owner}:${opts.head}`,
    base: opts.base,
    state: 'open',
  })
  const path = `${encodeURIComponent(opts.owner)}/${encodeURIComponent(opts.name)}`
  const res = await fetch(`${apiBase}/repos/${path}/pulls?${query}`, {
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
