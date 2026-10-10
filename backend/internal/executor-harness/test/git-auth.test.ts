import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  NON_INTERACTIVE_CREDENTIAL_ARGS,
  classifyPushRejection,
  cloneRepo,
  describeGitFailure,
  isGitTimeoutKill,
} from '../src/git.js'
import { HarnessFailure } from '../src/failure.js'

// The non-interactive-auth hardening: a per-command timeout kill must be reported as a STALL
// (not a bare rejection), a caller/watchdog abort must NOT be mistaken for one, and a genuine
// git failure must surface git's stderr (which execFile hangs off `.stderr`, not `.message`).

describe('isGitTimeoutKill', () => {
  it('is true for an execFile timeout kill (killed + signal, not aborted)', () => {
    const err = Object.assign(new Error('Command failed: git push'), {
      killed: true,
      signal: 'SIGTERM' as const,
      code: null,
    })
    expect(isGitTimeoutKill(err, false)).toBe(true)
  })

  it('is false when the caller signal aborted (a watchdog kill owns that story)', () => {
    const err = Object.assign(new Error('Command failed: git push'), {
      killed: true,
      signal: 'SIGTERM' as const,
    })
    expect(isGitTimeoutKill(err, true)).toBe(false)
  })

  it('is false for an AbortError even without the aborted flag', () => {
    const err = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })
    expect(isGitTimeoutKill(err, false)).toBe(false)
  })

  it('is false for a normal non-zero exit (not killed)', () => {
    const err = Object.assign(new Error('Command failed: git push'), {
      killed: false,
      code: 128,
      stderr: 'fatal: repository not found',
    })
    expect(isGitTimeoutKill(err, false)).toBe(false)
  })
})

describe('non-interactive credential args', () => {
  // Regression guard for the #678 break: `-c credential.interactive=false` is honored by modern
  // git (≥ 2.47) and makes it SKIP GIT_ASKPASS, so every authenticated clone/push died with
  // "unable to get password from user". The empty helper list is what defeats the GCM popup; the
  // interactive flag must never come back.
  it('empties the credential helper but never sets credential.interactive', () => {
    expect(NON_INTERACTIVE_CREDENTIAL_ARGS).toContain('credential.helper=')
    expect(NON_INTERACTIVE_CREDENTIAL_ARGS).not.toContain('credential.interactive=false')
    expect(NON_INTERACTIVE_CREDENTIAL_ARGS.join(' ')).not.toMatch(/credential\.interactive/)
  })
})

describe('git failure surfacing', () => {
  it('folds git stderr into a redacted HarnessFailure(git) instead of a bare "Command failed"', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'git-fail-'))
    try {
      const missing = join(dir, 'does-not-exist')
      // Clone a nonexistent local repo: git exits non-zero with a real reason on stderr.
      const err = await cloneRepo({
        repo: { owner: 'o', name: 'r', baseBranch: 'main', cloneUrl: `file://${missing}` },
        ghToken: 'unused-for-file-origin',
        dir: join(dir, 'out'),
      }).catch((e) => e)
      expect(err).toBeInstanceOf(HarnessFailure)
      expect((err as HarnessFailure).failureCause).toBe('git')
      // The message carries git's own diagnostic (from stderr), not just "Command failed".
      expect((err as Error).message.toLowerCase()).toMatch(
        /does not exist|not a git repository|repository/,
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('describeGitFailure (F1: auth/access remedies)', () => {
  it('classifies an authentication failure → credential-rejected remedy', () => {
    const remedy = describeGitFailure(
      'remote: Invalid username or password.\nfatal: Authentication failed',
    )
    expect(remedy).toMatch(/authentication was rejected/i)
    expect(remedy).toMatch(/expired, rotated, revoked/i)
  })

  it('classifies "could not read Username" (non-interactive prompt) as an auth failure', () => {
    const remedy = describeGitFailure(
      "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
    )
    expect(remedy).toMatch(/authentication was rejected/i)
  })

  it('classifies a repository-not-found (404) → visibility/access remedy, not an auth one', () => {
    const remedy = describeGitFailure('remote: Repository not found.\nfatal: repository not found')
    expect(remedy).toMatch(/could not be found or is not visible/i)
    expect(remedy).not.toMatch(/authentication was rejected/i)
  })

  it('classifies a push permission denial (403) → write-access remedy', () => {
    const remedy = describeGitFailure(
      'remote: Permission to owner/repo.git denied to cat-factory[bot].\nfatal: unable to access',
    )
    expect(remedy).toMatch(/lacks WRITE access/i)
  })

  it('classifies a secondary-rate-limit (403) → wait-and-retry remedy, not write-access', () => {
    const remedy = describeGitFailure(
      'remote: You have triggered an abuse detection mechanism. Please wait and retry.\nfatal: unable to access: The requested URL returned error: 403',
    )
    expect(remedy).toMatch(/rate-limited this run/i)
    expect(remedy).not.toMatch(/lacks WRITE access/i)
  })

  it('returns undefined for an unrecognized failure (keeps just the raw stderr)', () => {
    expect(describeGitFailure('fatal: the remote end hung up unexpectedly')).toBeUndefined()
  })
})

describe('classifyPushRejection (a refused push is not a generic git fault)', () => {
  // The two shapes git prints for a refused push, and the third that only LOOKS like one. The
  // real-git pair in `git-push-lease.test.ts` pins that git actually emits these; this table pins
  // what each one classifies to, including the case the ordering exists for.
  it('reads a host-side REFUSAL as neither shape (re-dispatching cannot help)', () => {
    // GitHub's protected-branch message contains the words "non-fast-forward push", so this is the
    // case that would misclassify as a rewrite, and be re-dispatched to fail identically.
    const stderr =
      'remote: error: GH006: Protected branch update failed for refs/heads/main.\n' +
      'remote: error: refusing to allow a non-fast-forward push to a protected branch\n' +
      ' ! [remote rejected] main -> main (protected branch hook declined)'
    expect(classifyPushRejection(stderr)).toBeUndefined()
    // It keeps the write-access remedy, which is the one that names the actual fix.
    expect(describeGitFailure(stderr)).toMatch(/lacks WRITE access/i)
  })

  it('reads an ordinary git failure as neither shape', () => {
    expect(classifyPushRejection('fatal: the remote end hung up unexpectedly')).toBeUndefined()
  })

  it('resolves a stderr carrying BOTH shapes in the documented order', () => {
    // The ordering `classifyPushRejection` documents is the only thing these fixtures test, and
    // nothing else can: each real-git refusal in `git-push-lease.test.ts` matches exactly one
    // shape, so swapping the branches leaves every other assertion in both files green. Both
    // halves below are real git output (a `(stale info)` lease refusal, and the hint block git
    // prints for a plain non-fast-forward, which contains "tip of your current branch is behind").
    const staleInfo =
      ' ! [rejected]        c0ffee -> wb (stale info)\nerror: failed to push some refs'
    const nonFastForward =
      ' ! [rejected]        c0ffee -> wb (non-fast-forward)\n' +
      'error: failed to push some refs\n' +
      'hint: Updates were rejected because the tip of your current branch is behind\n' +
      "hint: its remote counterpart. If you want to integrate the remote changes,\nhint: use 'git pull' before pushing again."
    // A SECOND WRITER wins over the rewrite shape: it is the one that says the branch holds commits
    // this checkout has never seen, and its remedy is the one that names another writer.
    expect(classifyPushRejection(`${staleInfo}\n${nonFastForward}`)).toBe('remote-writer')
    expect(classifyPushRejection(`${nonFastForward}\n${staleInfo}`)).toBe('remote-writer')
    // And the host-side guard wins over both, because no re-dispatch resolves branch protection.
    const hostRefusal =
      'remote: error: pre-receive hook declined\n ! [remote rejected] wb -> wb (pre-receive hook declined)'
    expect(classifyPushRejection(`${hostRefusal}\n${staleInfo}`)).toBeUndefined()
    expect(classifyPushRejection(`${hostRefusal}\n${nonFastForward}`)).toBeUndefined()
  })

  it('never advises `git pull`, which no autonomous run can act on', () => {
    // git's own hint for both shapes is "use 'git pull' before pushing again", which is advice for a
    // person at a terminal. The remedy has to name what the PLATFORM does instead.
    for (const stderr of [
      ' ! [rejected] b -> b (non-fast-forward)',
      ' ! [rejected] b -> b (stale info)',
    ]) {
      const remedy = describeGitFailure(stderr)
      expect(remedy).toBeDefined()
      expect(remedy).not.toMatch(/git pull/i)
      expect(remedy).toMatch(/re-dispatches the step/i)
    }
  })
})
