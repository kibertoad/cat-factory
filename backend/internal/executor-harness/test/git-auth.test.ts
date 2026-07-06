import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { NON_INTERACTIVE_CREDENTIAL_ARGS, cloneRepo, isGitTimeoutKill } from '../src/git.js'
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
