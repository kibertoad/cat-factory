import { describe, expect, it } from 'vitest'
import {
  explainInstallationTokenMintFailure,
  InstallationTokenMintError,
  installationTokenMintStatusOf,
} from '../src/github/GitHubAppAuth.js'

// C3 (error-message coverage): the terse `Failed to mint installation token for <id> (HTTP <s>)`
// now carries a cause + remedy. These assertions pin BOTH the elaboration AND that the two
// stale-installation reconcile regexes still match — the elaborated text must never break
// classification (see `reconcileStaleRepos.ts`).
const GONE_REGEX = /Failed to mint installation token .*\(HTTP (404|410)\)/i
const ANY_GONE_REGEX = /\(HTTP (401|404|410)\)/

describe('explainInstallationTokenMintFailure', () => {
  it('preserves the load-bearing first line verbatim', () => {
    for (const status of [401, 403, 404, 410, 500]) {
      expect(explainInstallationTokenMintFailure(42, status)).toContain(
        `Failed to mint installation token for 42 (HTTP ${status})`,
      )
    }
  })

  it('401 names a wrong/rotated App private key', () => {
    const msg = explainInstallationTokenMintFailure(7, 401)
    expect(msg).toMatch(/GITHUB_APP_PRIVATE_KEY/)
    expect(msg).toMatch(/rotated/)
    expect(msg).toContain('https://github.com/settings/installations')
    // The 401-gone regex must still match (a persistent app-JWT fault is caught by the reconcile).
    expect(ANY_GONE_REGEX.test(msg)).toBe(true)
  })

  it('404 and 410 name an uninstalled/stale installation and still match the gone regex', () => {
    for (const status of [404, 410]) {
      const msg = explainInstallationTokenMintFailure(99, status)
      expect(msg).toMatch(/uninstalled|stale installation/)
      expect(msg).toMatch(/reconnect GitHub/)
      expect(GONE_REGEX.test(msg)).toBe(true)
      expect(ANY_GONE_REGEX.test(msg)).toBe(true)
    }
  })

  it('403 points at App id + key + clock', () => {
    const msg = explainInstallationTokenMintFailure(1, 403)
    expect(msg).toMatch(/rate-limited|rejected/)
    expect(msg).toMatch(/clock/)
  })

  it('an unmapped status falls back to the bare line', () => {
    expect(explainInstallationTokenMintFailure(5, 500)).toBe(
      'Failed to mint installation token for 5 (HTTP 500)',
    )
  })
})

describe('InstallationTokenMintError (I7 structured code)', () => {
  it('carries the status + installationId as fields and the elaborated message', () => {
    const err = new InstallationTokenMintError(42, 404)
    expect(err.status).toBe(404)
    expect(err.installationId).toBe(42)
    expect(err.name).toBe('InstallationTokenMintError')
    expect(err.message).toContain('Failed to mint installation token for 42 (HTTP 404)')
    expect(err.message).toMatch(/uninstalled|stale installation/)
  })

  it('installationTokenMintStatusOf reads the status via instanceof', () => {
    expect(installationTokenMintStatusOf(new InstallationTokenMintError(1, 410))).toBe(410)
  })

  it('returns undefined for anything that is not a real mint error', () => {
    // A repo-level error also carries a `status`, but is NOT a gone installation — the mint
    // status is read ONLY off the class (in-process throw), never a look-alike plain object.
    expect(
      installationTokenMintStatusOf({ name: 'InstallationTokenMintError', status: 401 }),
    ).toBeUndefined()
    expect(installationTokenMintStatusOf(new Error('Failed to mint … (HTTP 404)'))).toBeUndefined()
  })
})
