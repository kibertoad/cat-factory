import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ONBOARDING_PRESEED_KEYS,
  assertOnboardingKeysCurrent,
  writeOnboardingPreseed,
} from '../src/onboarding-preseed.js'
import type { Logger } from '../src/logger.js'

// D4: the onboarding pre-seed + its "keys still current" assertion.

function recordingLogger(): { log: Logger; warns: unknown[][]; infos: unknown[][] } {
  const warns: unknown[][] = []
  const infos: unknown[][] = []
  const log = {
    info: (...a: unknown[]) => infos.push(a),
    warn: (...a: unknown[]) => warns.push(a),
    error: () => {},
    debug: () => {},
    child: () => log,
  } as unknown as Logger
  return { log, warns, infos }
}

describe('onboarding pre-seed', () => {
  let home: string
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cf-onboard-'))
  })
  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  it('writes the pinned onboarding keys as an accepted config', async () => {
    await writeOnboardingPreseed(home)
    const written = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8')) as Record<
      string,
      unknown
    >
    expect(written).toEqual(ONBOARDING_PRESEED_KEYS)
  })

  it('logs the applied keys with the CLI version when the pre-seed is intact', async () => {
    await writeOnboardingPreseed(home)
    const { log, warns, infos } = recordingLogger()
    await assertOnboardingKeysCurrent(home, '2.1.207', log)
    expect(warns).toHaveLength(0)
    expect(infos).toHaveLength(1)
    expect(infos[0]?.[1]).toMatchObject({ cliVersion: '2.1.207' })
  })

  it('warns when an expected key did not land', async () => {
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true }))
    const { log, warns } = recordingLogger()
    await assertOnboardingKeysCurrent(home, undefined, log)
    expect(warns).toHaveLength(1)
    expect(warns[0]?.[1]).toMatchObject({
      missing: expect.arrayContaining(['hasTrustDialogAccepted']),
    })
  })

  it('warns (never throws) when the file is unreadable', async () => {
    const { log, warns } = recordingLogger()
    await expect(assertOnboardingKeysCurrent(home, undefined, log)).resolves.toBeUndefined()
    expect(warns).toHaveLength(1)
  })
})
