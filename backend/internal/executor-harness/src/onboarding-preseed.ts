import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Logger } from './logger.js'

// ADR 0026 D4 (paired assertion). A brand-new Claude Code config home would otherwise
// make `claude -p` block on the interactive onboarding / "trust this folder" /
// bypass-permissions acknowledgement prompts — which never get answered headlessly,
// hanging the job until the inactivity watchdog kills it with no output. We pre-seed a
// `.claude.json` marking those gates as already accepted.
//
// The hazard the ADR calls out: if a future CLI version adds a NEW first-run gate this
// set does not cover, the symptom is identical to a healthy-but-quiet subagent run (no
// stdout, low CPU), so the cold-start watchdog can't tell them apart on its own. This
// module centralises the pre-seeded keys as ONE source of truth and logs the pinned set
// (with the installed CLI version) so that, when the cold-start watchdog fires, an
// operator has the exact keys-vs-version pairing to diff against a new gate.

/**
 * The onboarding gates we pre-accept in a fresh config home. Kept as a single constant so
 * the write and the assertion below can never drift, and so a new gate is added in exactly
 * one place. If the CLI renames/adds a key, this is where the fix lands.
 */
export const ONBOARDING_PRESEED_KEYS = {
  hasCompletedOnboarding: true,
  bypassPermissionsModeAccepted: true,
  hasTrustDialogAccepted: true,
} as const

/** Write the onboarding pre-seed into `<configHome>/.claude.json`. Best-effort; never throws. */
export async function writeOnboardingPreseed(configHome: string): Promise<void> {
  await writeFile(join(configHome, '.claude.json'), JSON.stringify(ONBOARDING_PRESEED_KEYS), {
    mode: 0o600,
  }).catch(() => {})
}

/**
 * Verify the pre-seed actually landed and log the pinned onboarding keys alongside the
 * installed CLI version — the "one-line assertion after the pre-seed" from D4. It cannot
 * introspect the CLI's true first-run gate set (the CLI never exposes it), so it does the
 * two things it CAN do cheaply and deterministically: confirm every key we intended is
 * present + truthy in the written file (catching a botched write), and emit a structured
 * record pairing the keys with the CLI version so a future onboarding regression — surfaced
 * by the cold-start watchdog as a silent, output-less start — is diffable against a new gate.
 * Best-effort; never throws.
 */
export async function assertOnboardingKeysCurrent(
  configHome: string,
  cliVersion: string | undefined,
  log: Logger | undefined,
): Promise<void> {
  const expected = Object.keys(ONBOARDING_PRESEED_KEYS)
  let parsed: Record<string, unknown> = {}
  try {
    parsed = JSON.parse(await readFile(join(configHome, '.claude.json'), 'utf8')) as Record<
      string,
      unknown
    >
  } catch {
    log?.warn('onboarding pre-seed could not be read back after write', {
      onboardingKeys: expected,
      ...(cliVersion ? { cliVersion } : {}),
    })
    return
  }
  const missing = expected.filter((k) => parsed[k] !== true)
  if (missing.length > 0) {
    log?.warn('onboarding pre-seed is missing expected keys', {
      onboardingKeys: expected,
      missing,
      ...(cliVersion ? { cliVersion } : {}),
    })
    return
  }
  log?.info('onboarding pre-seed applied', {
    onboardingKeys: expected,
    ...(cliVersion ? { cliVersion } : {}),
  })
}
