import { execFile } from 'node:child_process'
import { appendFile, chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { BootstrapTargetSpec, RepoSpec } from './job.js'
import { pathExists } from './fs-utils.js'
import { redactSecrets } from './redact.js'
import { loadRunnerLimits } from './runner.js'
import { HarnessFailure } from './failure.js'

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

// Config prefixed to EVERY git invocation to force fully non-interactive authentication.
//
// WHY: in native local mode the harness runs as a plain host process, so `git` inherits the
// developer's host git config. On Windows that config has `credential.helper=manager` (Git
// Credential Manager), and git consults its credential helpers BEFORE ever reaching
// `GIT_ASKPASS`. GCM then pops up an interactive OS auth dialog on clone/fetch/push — which in
// an autonomous, non-interactive run either steals focus with a stray window or, when the
// dialog is modal, blocks the git process until it hits GIT_TIMEOUT_MS and is killed (the
// classic "git push hung for ~7 minutes then failed" symptom).
//
// Emptying the helper list (`credential.helper=` with no value RESETS the multi-valued config,
// dropping the system/global/local helpers) removes GCM from the chain, so git falls back to
// the harness's own askpass helper — which returns the per-job PAT we already hold (see
// `authEnv`). The token is never in argv; only this non-secret config is.
//
// DO NOT re-add `-c credential.interactive=false` here. It reads like harmless belt-and-braces
// but modern git (≥ 2.47, incl. the executor image + host git) HONORS `credential.interactive`
// and treats invoking GIT_ASKPASS as "interactive" — so with it set git SKIPS the askpass
// entirely and dies with "fatal: unable to get password from user", failing EVERY authenticated
// clone/push on both the native and container paths (it clones a public base repo fine — that
// needs no auth — then fails only at push, which is what makes it look intermittent). The GCM
// popup it was meant to belt-and-braces against is already fully handled by the emptied helper
// list above plus `GIT_TERMINAL_PROMPT=0` / `GCM_INTERACTIVE=never` in the env (see authEnv /
// nonInteractiveGitEnv). Exported so a unit test can pin that this arg never creeps back in.
export const NON_INTERACTIVE_CREDENTIAL_ARGS = ['-c', 'credential.helper=']

/**
 * Env applied to git commands that DON'T carry {@link authEnv} (local ops like config/checkout/
 * rev-parse). Keeps them from ever going interactive too — `GIT_TERMINAL_PROMPT=0` blocks the
 * terminal prompt and `GCM_INTERACTIVE=never` blocks a Git Credential Manager popup even if a
 * helper somehow survives. `authEnv` sets the same pair for the network ops.
 */
function nonInteractiveGitEnv(): NodeJS.ProcessEnv {
  return { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' }
}

/** The shape `execFile` decorates its rejection with — the bits we read to classify a failure. */
type ExecError = Error & {
  killed?: boolean
  signal?: NodeJS.Signals | null
  code?: number | string | null
  stderr?: string | Buffer
  stdout?: string | Buffer
}

/**
 * Whether `err` is a per-command TIMEOUT kill (the child exceeded `execFile`'s `timeout`, so
 * Node killed it with `killSignal` and set `killed=true`) — as opposed to a normal non-zero
 * exit or a watchdog/caller abort. `aborted` is the caller signal's state: an abort ALSO
 * kills the child, but it's the outer watchdog's story (recorded via `killReason` upstream),
 * so it must NOT be reported here as a git timeout. Pure, so the classification is unit-tested.
 */
export function isGitTimeoutKill(err: unknown, aborted: boolean): boolean {
  if (aborted) return false
  const e = err as ExecError
  if (e?.name === 'AbortError') return false
  return e?.killed === true && e?.signal != null
}

/** The first non-flag token of a git argv (the subcommand — `push`/`clone`/…), for messages. */
function gitSubcommand(args: string[]): string {
  return args.find((a) => a !== '' && !a.startsWith('-')) ?? 'command'
}

/**
 * Why a push to the work branch was REFUSED. Both mean the branch carries commits this push
 * would drop, and git tells them apart by whether our object database HOLDS the tip the remote
 * reports: it does for a tip our own checkout created, so the two are distinguishable and need
 * different remedies (see {@link PUSH_REJECTION_REMEDIES}).
 *
 *  - `local-rewrite`: we HAVE the remote's tip and are no longer descended from it, i.e. this
 *    checkout amended / reset / rebased a commit that had already been pushed. Git labels it
 *    `(non-fast-forward)`.
 *  - `remote-writer`: the remote's tip is a commit this checkout has never seen (`(fetch first)`),
 *    or our lease found the branch moved past what we published (`(stale info)`), so a SECOND
 *    writer owns the branch.
 */
export type PushRejection = 'local-rewrite' | 'remote-writer'

/**
 * Whether `stderr` is a REFUSED push, and which shape. Ordered: the lease/fetch-first shapes are
 * checked first, because a `(stale info)` refusal also prints the generic "failed to push some
 * refs" line the non-fast-forward shape shares. Pure, so both branches are unit-tested against
 * real git output rather than inferred.
 */
export function classifyPushRejection(stderr: string): PushRejection | undefined {
  // A HOST-side refusal is not contention, and re-dispatching cannot help: branch protection, a
  // pre-receive hook or a token policy is declining the write itself, and GitHub's protected-branch
  // message says "refusing to allow a non-fast-forward push", which would otherwise read as a
  // rewrite. Git's own labels separate the two cleanly (`! [remote rejected]` is the server
  // declining, `! [rejected]` is git's own fast-forward/lease check), so such a failure stays a
  // plain `git` fault with the write-access remedy below.
  if (/remote rejected|protected branch|hook declined|refusing to allow/i.test(stderr)) {
    return undefined
  }
  if (/\(stale info\)|\(fetch first\)|remote contains work that you do not/i.test(stderr)) {
    return 'remote-writer'
  }
  if (
    /\(non-fast-forward\)|tip of your current branch is behind|branch tip is behind/i.test(stderr)
  ) {
    return 'local-rewrite'
  }
  return undefined
}

/**
 * The remedy each {@link PushRejection} earns. A `Record`, so a new rejection shape cannot be
 * classified without saying what a human should do about it. Neither is "run `git pull`", which is
 * what git's own hint advises and is advice for a person at a terminal, not for an autonomous run.
 */
const PUSH_REJECTION_REMEDIES: Record<PushRejection, string> = {
  'local-rewrite':
    'The push was refused because the commit it publishes is not descended from the one the work ' +
    'branch already holds: this checkout rewrote history that had already been pushed (an amend, ' +
    "reset or rebase of an existing commit). The platform checkpoint-pushes the agent's commits " +
    'while it works and lets a run force over its OWN published checkpoint, so what stays refused ' +
    'is a rewrite it cannot attribute to this pass: commits an earlier run published, or a rewrite ' +
    'that dropped the branch tip this pass started from. The engine re-dispatches the step to ' +
    'resume from the branch as it stands; work already on the branch is never dropped.',
  'remote-writer':
    'The push was refused because another writer advanced this work branch while the run was ' +
    'working (a second dispatch for the same block, or a person pushing to it). Nothing is lost: ' +
    "the other writer's commits stay on the branch and the engine re-dispatches the step so the " +
    'agent resumes on top of them. If it recurs, check whether two runs are active for the same block.',
}

/**
 * Classify the common shapes of git's own stderr into an actionable remedy, else undefined
 * (an unrecognized failure keeps just its raw stderr). This is the FIRST-WRAP-POINT for
 * unavoidable third-party text (per the error-message initiative's I6): git's stderr is the
 * only signal we get for a clone/push auth or access fault, so we match it ONCE here and
 * APPEND a cause + fix, never rewrite the raw line. Host-neutral — the same remedy serves a
 * GitHub-App installation token and a GitLab/GitHub PAT (local mode). Pure, so it is
 * unit-tested over a fixed set of stderr strings.
 */
export function describeGitFailure(stderr: string): string | undefined {
  const s = stderr.toLowerCase()
  // A refused push first: its stderr carries neither an auth nor an access shape, so a miss here
  // would leave the operator git's own "use 'git pull' before pushing again" hint and nothing else.
  const rejection = classifyPushRejection(stderr)
  if (rejection) return PUSH_REJECTION_REMEDIES[rejection]
  // Rate-limit / abuse-detection first: the host returns these as a 403, which would
  // otherwise fall into the write-access shape below and be mislabeled as a permission
  // problem — but the fix is to wait, not to grant access.
  if (/rate limit|secondary rate|abuse detection/i.test(stderr)) {
    return (
      'The git host rate-limited this run (a primary/secondary rate limit or abuse-detection ' +
      'trip). This is usually transient — wait a few minutes and retry. If it persists, reduce ' +
      'the number of concurrent runs against this host.'
    )
  }
  // Order matters: a 404 "repository not found" is sometimes GitHub's stand-in for "your
  // token can't see this private repo", so it is checked before the generic auth shape.
  if (
    /repository not found|remote:\s*not found|returned error:\s*404|fatal:\s*could not read from remote repository/i.test(
      stderr,
    ) &&
    !/authentication failed|invalid username or password/i.test(s)
  ) {
    return (
      'The repository could not be found or is not visible to the credential used for this run. ' +
      'It may have been deleted, renamed, or made private, or the GitHub App installation / access ' +
      'token no longer has access to it. Confirm the repository still exists and that the connected ' +
      'GitHub App (or, in local mode, the GITHUB_PAT) can see it, then retry.'
    )
  }
  if (
    /authentication failed|invalid username or password|could not read username|could not read password|terminal prompts disabled|support for password authentication was removed|returned error:\s*401|http basic:\s*access denied/i.test(
      stderr,
    )
  ) {
    return (
      'Git authentication was rejected — the credential this run used was refused. The GitHub App ' +
      'installation token (or, in local mode, the GITHUB_PAT) is most likely expired, rotated, ' +
      'revoked, or no longer installed on this repository. Reconnect the GitHub App for the ' +
      'workspace (or regenerate the PAT with repo scope in local mode), then retry.'
    )
  }
  if (
    /permission to .* denied|remote:\s*permission|protected branch|pre-receive hook declined|returned error:\s*403|http 403/i.test(
      stderr,
    )
  ) {
    return (
      'Git authenticated but the credential lacks WRITE access to push to this repository. Grant ' +
      'the connected GitHub App (or the local-mode PAT) write permission on the repo — and, if the ' +
      'target branch is protected, the permission its branch-protection rule requires — then retry.'
    )
  }
  return undefined
}

/**
 * Wrap a git failure into a credential-scrubbed {@link HarnessFailure}('git') with an ACCURATE
 * message. Three cases the old bare "Command failed: git …" collapsed together:
 *  - a per-command timeout kill → say it STALLED (and name the usual causes) instead of a blank
 *    "Command failed", so a hung push/clone reads as a timeout rather than a mystery rejection;
 *  - a real non-zero exit → fold in git's `stderr` (execFile puts the actual reason THERE, not
 *    on `.message`, which is only "Command failed: <cmd>"), so the surfaced error has content;
 *  - anything else → the scrubbed message.
 */
function gitFailure(err: unknown, args: string[], aborted: boolean): HarnessFailure {
  const e = err as ExecError
  if (isGitTimeoutKill(err, aborted)) {
    const failure = new HarnessFailure(
      'git',
      redactSecrets(
        `git ${gitSubcommand(args)} timed out after ${Math.round(GIT_TIMEOUT_MS / 1000)}s with no ` +
          'progress — the operation stalled. Likely a very large clone/push, a slow or blocked ' +
          'network, or an interactive credential prompt (e.g. a Git Credential Manager popup) that ' +
          'a non-interactive run cannot answer.',
      ),
    )
    if (e?.stack) failure.stack = redactSecrets(e.stack)
    return failure
  }
  const stderr = typeof e?.stderr === 'string' ? e.stderr : (e?.stderr?.toString() ?? '')
  const base = e instanceof Error ? e.message : String(err)
  // `execFile` builds its rejection message as `Command failed: <cmd>\n<stderr>`, so for the
  // ordinary non-zero exit the stderr is ALREADY in `base`, and appending it again printed every
  // git failure's output twice, which reads as two attempts. Append only what `base` lacks
  // (a killed/other rejection whose message carries no output).
  const tail = stderr.trim()
  const combined = tail && !base.includes(tail) ? `${base}\n${tail}` : base
  // Append a cause + fix for the recognized auth/access/push-rejection shapes, keeping the raw
  // (scrubbed) stderr above it as the detail. The remedy is static text with no secrets, so it is
  // added after redaction.
  const remedy = describeGitFailure(combined)
  const message = remedy ? `${redactSecrets(combined)}\n${remedy}` : redactSecrets(combined)
  // A REFUSED push is not a generic `git` fault: the branch moved under this run, which the engine
  // recovers from by re-dispatching the step onto the branch as it now stands. It gets its own
  // structured cause so that recovery keys off a classification rather than this message.
  const failure = new HarnessFailure(
    classifyPushRejection(combined) ? 'branch-contended' : 'git',
    message,
  )
  if (e?.stack) failure.stack = redactSecrets(e.stack)
  return failure
}

/**
 * Build the remote URL git uses. Only the username (`x-access-token`) is embedded
 * — never the token — so the token never appears in argv. The token is supplied
 * separately via {@link authEnv} and read by the GIT_ASKPASS helper.
 *
 * The `x-access-token` username is host-neutral: GitHub keys auth off the token (password)
 * and ignores the username, and GitLab likewise accepts ANY non-blank username with a PAT as
 * the password — so the same embedded username authenticates github.com and gitlab.com alike.
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
    // Never fall back to an interactive prompt / GUI credential dialog (which would hang the
    // job or steal focus). Paired with the emptied credential helper in the git argv, this is
    // what keeps a native-mode run from ever surfacing a Git Credential Manager popup.
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
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
  // Force non-interactive auth on EVERY git op: empty the credential-helper list (drops the
  // host's Git Credential Manager, whose popup otherwise steals focus or hangs the command)
  // and, for ops without the auth env, still block a terminal/GCM prompt. See the notes on
  // NON_INTERACTIVE_CREDENTIAL_ARGS / authEnv above.
  try {
    const { stdout } = await exec('git', [...NON_INTERACTIVE_CREDENTIAL_ARGS, ...args], {
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      maxBuffer: 16 * 1024 * 1024,
      timeout: GIT_TIMEOUT_MS,
      env: opts.env ?? nonInteractiveGitEnv(),
      ...(opts.signal ? { signal: opts.signal } : {}),
    })
    return stdout
  } catch (err) {
    // Tag the failure as `git` so the registry's catch records the real cause instead of
    // the generic `agent`. A watchdog abort still wins: `describeFailure` keys off
    // `killReason` first, so an abort during a git op keeps the timeout message/cause.
    throw gitFailure(err, args, opts.signal?.aborted === true)
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
 * The raw `git status --porcelain --untracked-files=all` output for `dir` — every path git
 * considers changed, with untracked files enumerated INDIVIDUALLY rather than collapsed to their
 * directory.
 *
 * The raw string, not a parsed list, because its two consumers want different things from it and
 * the parse ({@link changedPathsFromPorcelain}) is pure and shared: the workspace probe wants "is
 * anything here at all", the salvage wants the paths themselves. Gitignored paths are absent by
 * construction, which is what keeps a dependency install from reading as agent progress.
 *
 * NOTHING IS STAGED, unlike {@link hasAgentChanges}: this runs mid-flight, while the agent is
 * still working, so a `git add -A` here would silently stage files the agent had not chosen and
 * change what a later `commitTrackedEdits` captures.
 */
export async function workingTreeStatus(dir: string, signal?: AbortSignal): Promise<string> {
  return git(['status', '--porcelain', '--untracked-files=all'], { cwd: dir, signal })
}

/**
 * Stage exactly `paths` and commit them with `message`, returning the new commit's sha (or null
 * when git found nothing to commit — a path that vanished between listing and staging).
 *
 * `--` terminates the options so a path beginning with `-` cannot be read as a flag, and the
 * paths are passed as separate argv entries so no shell ever sees them. The caller has already
 * decided WHICH paths belong; this only commits them.
 */
export async function commitPaths(
  dir: string,
  paths: string[],
  message: string,
  signal?: AbortSignal,
): Promise<string | null> {
  if (paths.length === 0) return null
  await git(['add', '--', ...paths], { cwd: dir, signal })
  const staged = await git(['diff', '--cached', '--name-only'], { cwd: dir, signal })
  if (staged.trim() === '') return null
  await git(['commit', '-m', message], { cwd: dir, signal })
  return headCommit(dir, signal)
}

/**
 * The untracked, non-ignored paths in the working tree with whole untracked DIRECTORIES
 * collapsed to a single `dir/` entry (`--directory`), rather than every file beneath them.
 *
 * The sibling {@link listUntrackedFiles} answers "what did the agent forget to commit", where
 * every individual file is the point. This one answers "what appeared in the tree", where it is
 * emphatically not: a dependency install leaves tens of thousands of files under one directory,
 * and enumerating them would cost a multi-megabyte listing to learn a single name.
 */
export async function listUntrackedPaths(dir: string, signal?: AbortSignal): Promise<string[]> {
  const out = await git(
    ['ls-files', '--others', '--exclude-standard', '--directory', '--no-empty-directory'],
    { cwd: dir, signal },
  )
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

/**
 * Locally exclude LITERAL paths — never patterns — from this checkout, in ONE write.
 *
 * The sibling {@link excludeFromGit} takes an author-written pattern for a known sentinel. These
 * paths instead come from the FILESYSTEM (what a dependency install left behind), so two things
 * differ. Each is escaped, because a directory named `pkg[1]` read as a gitignore character class
 * excludes something else entirely and, being a no-op on the real path, fails silently. And they
 * are appended together, because a per-path append would cost one file write per entry to build
 * a list that is already known in full.
 *
 * Anchored: `ls-files` reports repo-root-relative paths and a gitignore pattern containing a
 * slash is root-anchored, which is what makes `packages/api/node_modules/` exclude that service's
 * tree and not a same-named directory elsewhere. Best-effort, exactly like its sibling.
 */
export async function excludePathsFromGit(
  dir: string,
  paths: readonly string[],
  signal?: AbortSignal,
): Promise<void> {
  if (paths.length === 0) return
  // Escape every gitignore metacharacter, plus a leading `#` (comment) or `!` (negation) which
  // are only special in that position.
  const escaped = paths.map((p) => p.replace(/[[\]*?\\]/g, '\\$&').replace(/^([#!])/, '\\$1'))
  try {
    const excludePath = join(dir, '.git', 'info', 'exclude')
    await appendFile(excludePath, `\n${escaped.join('\n')}\n`, 'utf8')
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
 * Whether the checked-out branch carries at least one commit the PR base does NOT — i.e.
 * `git rev-list --count <base>..HEAD > 0`. A resume clone is single-branch, so it has no
 * `origin/<base>` tracking ref; this fetches the base into a dedicated local ref first and
 * diffs HEAD against it.
 *
 * Tri-state on purpose:
 *  - `true`  — confirmed ≥1 commit ahead (there is something to open a PR for).
 *  - `false` — confirmed 0 commits ahead (the branch is reachable from base, e.g. its earlier
 *              PR was merged with a merge commit and the best-effort branch delete was skipped).
 *  - `undefined` — could not determine (fetch / rev-list error); the caller keeps its prior
 *              behaviour rather than wrongly dropping a resumed branch that has real work.
 *
 * Used by the resume path to avoid declaring a merged/empty branch as work and then failing
 * the run with GitHub's opaque 422 "No commits between <base> and <branch>".
 */
export async function branchAheadOfBase(
  dir: string,
  baseBranch: string,
  ghToken: string,
  signal?: AbortSignal,
): Promise<boolean | undefined> {
  try {
    await git(['fetch', 'origin', `+refs/heads/${baseBranch}:refs/cat-factory/base`], {
      cwd: dir,
      signal,
      env: await authEnv(ghToken),
    })
    const count = (
      await git(['rev-list', '--count', 'refs/cat-factory/base..HEAD'], { cwd: dir, signal })
    ).trim()
    return Number(count) > 0
  } catch {
    return undefined
  }
}

/**
 * The files `commitish` changes relative to its merge base with the PR base branch — i.e.
 * everything the work branch has added on top of base, `git diff --name-only <base>...<commitish>`.
 *
 * The BUGFIX REPRODUCTION PROOF uses this to answer the one question that decides whether a GREEN
 * pre-fix tree means anything: does that tree ALREADY carry non-test work committed on this
 * branch? A resumed run's `baseSha` is whatever the branch tip was when this pass started, which
 * in the designed flow is the reproduction step's test commit — but after an eviction it is this
 * same coder step's own interrupted work, fix included. Reporting "the check passed before your
 * change, so it does not demonstrate the defect" in that case is simply false.
 *
 * `undefined` means "could not determine" (a shallow clone with no reachable merge base, a fetch
 * failure, an unknown ref), never an empty list: the caller must degrade to its prior behaviour
 * rather than read a failed probe as "the tree is clean".
 *
 * NUL-delimited so a path containing a newline (legal in git) cannot split into two entries.
 */
export async function changedFilesSinceBase(
  dir: string,
  baseBranch: string,
  ghToken: string,
  commitish: string,
  signal?: AbortSignal,
): Promise<string[] | undefined> {
  try {
    await git(['fetch', 'origin', `+refs/heads/${baseBranch}:refs/cat-factory/base`], {
      cwd: dir,
      signal,
      env: await authEnv(ghToken),
    })
    const out = await git(['diff', '--name-only', '-z', `refs/cat-factory/base...${commitish}`], {
      cwd: dir,
      signal,
    })
    return out.split('\0').filter((p) => p !== '')
  } catch {
    return undefined
  }
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

/**
 * Add a DETACHED worktree of `commitish` at `worktreePath`, sharing `dir`'s object database.
 *
 * The bugfix reproduction proof runs the declared check against two trees of the SAME clone (the
 * pre-fix tree and the final tree), so a worktree is the only mechanism that gets both without a
 * second clone, a second fetch, or disturbing the agent's own checkout — which must stay exactly
 * as the agent left it, since the push and the PR come off it.
 *
 * `--detach` (rather than a branch) is deliberate: a worktree that claimed a branch would collide
 * with the work branch checked out in `dir`, and nothing here ever commits.
 *
 * `worktreePath` is expected to live OUTSIDE the checkout (a per-job temp root), so the worktree's
 * `.git` pointer file can never be swept into the agent's commit by a broad `git add -A`.
 */
export async function addWorktree(
  dir: string,
  worktreePath: string,
  commitish: string,
  signal?: AbortSignal,
): Promise<void> {
  await git(['worktree', 'add', '--detach', worktreePath, commitish], { cwd: dir, signal })
}

/**
 * Remove a worktree previously added by {@link addWorktree} and prune the stale administrative
 * entry, never throwing: teardown is bookkeeping, and a run whose PROOF succeeded must not fail
 * because a temp directory could not be cleaned up. The caller still deletes the temp root, so a
 * failure here leaks only a `.git/worktrees/<name>` record inside a container that is about to be
 * destroyed anyway.
 */
export async function removeWorktree(
  dir: string,
  worktreePath: string,
  signal?: AbortSignal,
): Promise<void> {
  try {
    await git(['worktree', 'remove', '--force', worktreePath], { cwd: dir, signal })
  } catch {
    // Fall through to the prune, which cleans up the record even when the directory is gone.
  }
  try {
    await git(['worktree', 'prune'], { cwd: dir, signal })
  } catch {
    // Best-effort by design (see the doc comment).
  }
}

/**
 * Which of `paths` actually exist in `commitish`'s tree. Used by the reproduction proof to tell a
 * DECLARED test file that was committed from one that only ever existed as an untracked working-
 * tree file: the proof runs against committed trees, so an unadded test is invisible to it — and
 * equally invisible to the push, which is the point worth telling the agent about rather than
 * reporting a verdict computed without the reproduction in it.
 *
 * Returns the input order/spelling of the paths that matched, so the caller can diff against its
 * declared list to name the missing ones verbatim.
 */
export async function pathsPresentAtCommit(
  dir: string,
  commitish: string,
  paths: readonly string[],
  signal?: AbortSignal,
): Promise<string[]> {
  if (paths.length === 0) return []
  const out = await git(['ls-tree', '-r', '--name-only', '-z', commitish, '--', ...paths], {
    cwd: dir,
    signal,
  })
  // NUL-delimited so a path containing a newline (legal in git) can't split into two entries.
  const present = new Set(out.split('\0').filter((p) => p !== ''))
  return paths.filter((p) => present.has(p))
}

/**
 * Check `paths` out of `commitish` into `dir`'s working tree (and index), leaving every other file
 * untouched.
 *
 * This is how the reproduction's declared TEST files are placed onto the pre-fix worktree, and the
 * narrowness is the whole safety property: a whole-tree checkout would drag the FIX across too and
 * green the base, manufacturing a "the test does not capture the defect" verdict out of a
 * perfectly good reproduction. Only the paths the caller has already sanitized are passed, and
 * `--` stops any of them being read as a revision.
 */
export async function checkoutPathsFrom(
  dir: string,
  commitish: string,
  paths: readonly string[],
  signal?: AbortSignal,
): Promise<void> {
  if (paths.length === 0) return
  await git(['checkout', commitish, '--', ...paths], { cwd: dir, signal })
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
 * The directory the reference-branches prompt section suggests for a `git worktree add` checkout of
 * a reference branch alongside the agent's own work. Excluded from the checkout (below) so the
 * embedded worktree can never be staged into the agent's PR — mirrors the `.cat-context/` treatment
 * in {@link file://./pi.ts}. Kept in step with the same literal in the backend's
 * `renderReferenceBranchesSection` (a separate package, so a shared constant isn't feasible).
 */
export const REFERENCE_WORKTREE_DIR = '.cat-reference'

/**
 * Fetch pre-existing REFERENCE branches into their `origin/<b>` tracking refs, so the agent can
 * inspect them read-only (`git log origin/<b>`, two-dot `git diff origin/<b>`,
 * `git show origin/<b>:<path>`) without any git network credentials of its own. The primary
 * checkout is a shallow single-branch clone, so these refs aren't present until fetched — and the
 * harness (which holds the per-job token) is the only place that can reach the remote. Uses an
 * explicit destination refspec (`+refs/heads/<b>:refs/remotes/origin/<b>`) and `--no-tags` so a
 * reference branch's tags don't pollute the checkout. Best-effort PER branch: a fetch failure (a
 * branch deleted since dispatch, a transient network error) is reported via `onSkip` and skipped,
 * never fatal — a reference branch is context, not the run's starting point (contrast the WORKING
 * branch, whose absence fails the dispatch loudly). Returns the branch names that fetched cleanly.
 *
 * On any successful fetch it locally excludes {@link REFERENCE_WORKTREE_DIR} from this checkout, so
 * if the agent follows the prompt's suggested `git worktree add .cat-reference/<b>` a broad
 * `git add -A` can never embed that worktree as a stray gitlink in the run's PR.
 */
export async function fetchReferenceBranches(opts: {
  dir: string
  branches: string[]
  ghToken: string
  signal?: AbortSignal
  /** Called once per branch that failed to fetch, so the caller (which owns a logger) can warn. */
  onSkip?: (branch: string, reason: string) => void
}): Promise<string[]> {
  const { dir, branches, ghToken, signal, onSkip } = opts
  if (branches.length === 0) return []
  const env = await authEnv(ghToken)
  const fetched: string[] = []
  for (const branch of branches) {
    try {
      await git(
        ['fetch', '--no-tags', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`],
        { cwd: dir, signal, env },
      )
      fetched.push(branch)
    } catch (err) {
      onSkip?.(branch, err instanceof Error ? err.message : String(err))
    }
  }
  // Keep the suggested reference-worktree dir out of the agent's commits (best-effort, per-clone).
  if (fetched.length > 0) await excludeFromGit(dir, `${REFERENCE_WORKTREE_DIR}/`, signal)
  return fetched
}

/** The local tracking ref a fetched PR/MR head lands on, so the reviewer reads `origin/pr-head`. */
export const PR_HEAD_REF = 'refs/remotes/origin/pr-head'

/**
 * The `git fetch` refspec that maps a PR/MR's server-side HEAD ref onto {@link PR_HEAD_REF}. A
 * PR head is a synthetic ref the host maintains, NOT part of a normal clone: GitHub exposes it at
 * `refs/pull/<n>/head`, GitLab at `refs/merge-requests/<n>/head`. Pure so the provider branch is
 * unit-tested without a network. The leading `+` forces the update (the ref is read-only here).
 */
export function pullHeadRefspec(number: number, provider: 'github' | 'gitlab'): string {
  const src =
    provider === 'gitlab' ? `refs/merge-requests/${number}/head` : `refs/pull/${number}/head`
  return `+${src}:${PR_HEAD_REF}`
}

/**
 * Fetch the reviewed PR/MR's HEAD into {@link PR_HEAD_REF} so a read-only reviewer can inspect the
 * PROPOSED code — files the PR adds (absent from the base checkout) and the head version of every
 * modified file — with `git diff origin/<base>...origin/pr-head`, `git show origin/pr-head:<path>`.
 * The base clone never includes the pull ref, and the container agent holds no git credential of
 * its own (the token lives with the harness), so the agent's own `git fetch pull/<n>/head` fails
 * on a private repo — this harness-side fetch (which carries the token out of band via GIT_ASKPASS,
 * exactly like {@link fetchReferenceBranches}) is what actually makes the head reachable.
 *
 * Best-effort: a fetch failure (a closed/deleted PR, a host without the pull ref, a transient
 * network error) is reported via `onSkip` and swallowed — the review then proceeds on the base
 * checkout + the injected diff, never fails. Returns whether the head was fetched.
 */
export async function fetchPullRequestHead(opts: {
  dir: string
  number: number
  provider: 'github' | 'gitlab'
  ghToken: string
  signal?: AbortSignal
  /** Called when the fetch failed, so the caller (which owns a logger) can warn. */
  onSkip?: (reason: string) => void
}): Promise<boolean> {
  const { dir, number, provider, ghToken, signal, onSkip } = opts
  try {
    await git(['fetch', '--no-tags', 'origin', pullHeadRefspec(number, provider)], {
      cwd: dir,
      signal,
      env: await authEnv(ghToken),
    })
    return true
  } catch (err) {
    onSkip?.(err instanceof Error ? err.message : String(err))
    return false
  }
}

/**
 * Push the work branch to origin and return the sha it PUBLISHED. The remote URL carries only the
 * username, so the token is supplied here via the askpass env (never in argv).
 *
 * The push names an explicit SOURCE COMMIT (`<sha>:refs/heads/<branch>`) rather than the branch,
 * which is what makes the return value exact rather than a guess. The agent commits while this
 * runs, so `git push origin <branch>` publishes whatever the branch ref holds at the moment git
 * reads it, and a caller that leases against a sha it read either side of that has leased against
 * the wrong commit. Reading it back from `refs/remotes/origin/<branch>` afterwards is worse than
 * inexact, it is EMPTY on the production checkout: a fresh coding run clones one branch
 * (`cloneRepo`), so the remote's fetch refspec covers the base alone and `git push` creates no
 * tracking ref for the work branch at all. Naming the sha needs no ref and no round trip.
 *
 * `-u` goes with it: with a non-branch source git sets no upstream config (verified), nothing in
 * the harness reads that config, and the agent is told never to push or pull.
 *
 * `expectRemoteSha` turns the push into a LEASED force (`--force-with-lease=<branch>:<sha>`), which
 * is how a run whose own checkpoint push it has since rewritten still lands. It is deliberately NOT
 * a plain `--force`: the lease succeeds only while the remote still holds the sha THIS run
 * published, so a second writer's commits refuse the push (`(stale info)`) instead of being
 * clobbered. Callers therefore pass only a sha this same pass published; leasing against a tip we
 * merely CLONED would force over an earlier run's work.
 */
export async function pushBranch(
  dir: string,
  branch: string,
  ghToken: string,
  signal?: AbortSignal,
  opts: { expectRemoteSha?: string } = {},
): Promise<string> {
  const sha = (
    await git(['rev-parse', '--verify', `refs/heads/${branch}`], { cwd: dir, signal })
  ).trim()
  const lease = opts.expectRemoteSha ? [`--force-with-lease=${branch}:${opts.expectRemoteSha}`] : []
  await git(['push', ...lease, 'origin', `${sha}:refs/heads/${branch}`], {
    cwd: dir,
    signal,
    env: await authEnv(ghToken),
  })
  return sha
}

/**
 * Whether `sha` is still reachable from `branch`'s tip, i.e. the branch CONTAINS it:
 * `git rev-list --count --max-count=1 <sha> --not refs/heads/<branch>` is 0 when everything
 * reachable from `sha` is reachable from the branch too (the tip itself counts as contained).
 *
 * Phrased as a rev-list rather than `merge-base --is-ancestor` on purpose: the latter answers "no"
 * by EXITING 1, which is indistinguishable here from a broken checkout, and this probe's whole job
 * is to be trusted only when it is a definite answer. Tri-state for the same reason (as
 * {@link branchAheadOfBase} is):
 *
 *  - `true`: confirmed contained.
 *  - `false`: confirmed dropped, so the branch was rewritten below `sha`.
 *  - `undefined`: could not determine (an unknown object, a rev-list error). A caller must not read
 *    a failed probe as either answer.
 *
 * The work-branch lease is gated on this: see {@link workBranchLease}.
 */
export async function branchContainsCommit(
  dir: string,
  branch: string,
  sha: string,
  signal?: AbortSignal,
): Promise<boolean | undefined> {
  try {
    const out = await git(
      ['rev-list', '--count', '--max-count=1', sha, '--not', `refs/heads/${branch}`],
      { cwd: dir, signal },
    )
    const count = Number(out.trim())
    return Number.isNaN(count) ? undefined : count === 0
  } catch {
    return undefined
  }
}

/**
 * The work branch's tip when it holds something UNPUBLISHED, else undefined: the answer to whether a
 * checkpoint tick has anything to do. Two ways of having nothing:
 *
 *  - the tip is still `baseSha`, so this pass has committed nothing. Pushing here would create the
 *    work branch at the base commit, and a later retry would see that zero-diff branch via
 *    `remoteBranchExists`, resume it as work, and fail to open a PR ("no commits between base and
 *    head"). A pass that never commits must leave NO branch behind.
 *  - the tip is `publishedSha`, so the last push already published it. Without this the checkpoint
 *    re-pushed an unchanged branch on every tick: an hour-long run committing eight times issued
 *    ~60 pushes, ~52 of them a full authenticated round trip answering "Everything up-to-date",
 *    each one counting against the host's push rate limits.
 *
 * That second condition is also what keeps the INTERVAL the right knob. It expresses the acceptable
 * loss window when a container dies (a property of the deployment's infra churn), not a rate: gated
 * this way, the tick publishes at most one push per commit the agent makes, whatever the model or
 * the run's length, so nothing here needs to be tuned per model.
 */
export async function unpublishedWorkBranchTip(args: {
  dir: string
  /** The branch tip this pass started from. */
  baseSha: string
  /** The sha this pass published, if any ({@link pushBranch}'s return). */
  publishedSha: string | undefined
  signal?: AbortSignal
}): Promise<string | undefined> {
  const head = await headCommit(args.dir, args.signal)
  if (head === args.baseSha || head === args.publishedSha) return undefined
  return head
}

/**
 * The lease a work-branch push is entitled to (the `opts` {@link pushBranch} takes): the sha this
 * pass last published, and nothing at all before it has published one.
 *
 * The extra condition is what bounds the force to THIS pass's own commits, which the lease alone
 * does not do and the design promises. Once one checkpoint has landed, a rewrite that drops
 * `baseSha` (the tip the pass started from, which on a RESUMED branch is an earlier run's published
 * work) would still lease successfully against our own checkpoint and carry those earlier commits
 * away with it. So the lease is withheld unless the branch still CONTAINS `baseSha`: the push then
 * goes out plain, git refuses it as a non-fast-forward, and the engine re-dispatches onto the
 * branch as it stands.
 *
 * A probe that could not answer withholds it too (`onWithheld('unreadable')`), because the two
 * mistakes are not symmetric: withholding costs a refused rewrite and one re-dispatch, trusting an
 * unreadable probe costs commits.
 */
export async function workBranchLease(args: {
  dir: string
  branch: string
  /** The branch tip this pass started from. */
  baseSha: string
  /** The sha this pass published, if any (`pushBranch`'s return). */
  publishedSha: string | undefined
  signal?: AbortSignal
  /** Told why the lease was withheld, so the harness can log it with its own logger. */
  onWithheld?: (probe: 'unreadable' | 'dropped') => void
}): Promise<{ expectRemoteSha?: string }> {
  if (!args.publishedSha) return {}
  const contains = await branchContainsCommit(args.dir, args.branch, args.baseSha, args.signal)
  if (contains === true) return { expectRemoteSha: args.publishedSha }
  args.onWithheld?.(contains === undefined ? 'unreadable' : 'dropped')
  return {}
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
 *
 * `signal` is the job watchdog's, and threading it is load-bearing rather than tidy: without
 * it the six commands below are bounded only by their own per-command timeouts, so an abort
 * raised during the push phase cannot interrupt them and the job keeps working for up to
 * ~6 × `GIT_TIMEOUT_MS` past its max-duration kill. Every other git helper here threads it.
 */
export async function reinitAndPush(opts: {
  dir: string
  target: BootstrapTargetSpec
  ghToken: string
  message: string
  signal?: AbortSignal
}): Promise<void> {
  const { dir, signal } = opts
  await rm(join(dir, '.git'), { recursive: true, force: true })
  await git(['init'], { cwd: dir, signal })
  // Start the history on the target's default branch (init may default to master).
  await git(['checkout', '-b', opts.target.defaultBranch], { cwd: dir, signal })
  await git(['config', 'user.name', GIT_AUTHOR], { cwd: dir, signal })
  await git(['config', 'user.email', GIT_EMAIL], { cwd: dir, signal })
  await git(['add', '-A'], { cwd: dir, signal })
  await git(['commit', '-m', opts.message], { cwd: dir, signal })
  const url = authenticatedCloneUrl(opts.target.cloneUrl)
  await git(['remote', 'add', 'origin', url], { cwd: dir, signal })
  await git(['push', '--force', '-u', 'origin', opts.target.defaultBranch], {
    cwd: dir,
    signal,
    env: await authEnv(opts.ghToken),
  })
}
