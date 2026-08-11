import type { RiskPolicySelectionRefusal } from '@cat-factory/contracts'
import { describe, expect, it } from 'vitest'
import en from '../../../i18n/locales/en.json'
import { moveRefusalKey } from './moveRefusal'

/** The thrown shape the contract client produces for a refused reparent (`ApiError.body`). */
const refused = (reason: string) => ({
  body: { error: { code: 'forbidden', details: { reason } } },
})

/**
 * Exhaustive BY CONSTRUCTION. A bare `RiskPolicySelectionRefusal[]` literal type-checks while
 * being SHORT, so a reason added to the contracts union would reach the user as the backend's
 * untranslated English with nothing failing; `satisfies Record<…>` fails to compile instead.
 */
const REASONS = Object.keys({
  relaxes_run_oversight: true,
  relaxes_role_sandbox: true,
  relaxes_role_submission_allowlist: true,
  relaxes_role_class_rule: true,
} satisfies Record<RiskPolicySelectionRefusal, true>) as RiskPolicySelectionRefusal[]

describe('moveRefusalKey', () => {
  it('maps every refusal reason to a key the catalog actually holds', () => {
    // Derived from the contracts union rather than a list written here, so a new reason fails
    // this rather than silently reaching the user as the backend's untranslated English.
    const catalog = (en as { board: { toast: { moveRefused: Record<string, string> } } }).board
      .toast.moveRefused
    for (const reason of REASONS) {
      const key = moveRefusalKey(refused(reason))
      expect(key, `${reason} has no key`).toBe(`board.toast.moveRefused.${reason}`)
      expect(catalog[reason], `${reason} has no copy`).toBeTruthy()
    }
    // And nothing else: copy for a reason the backend cannot send is copy nobody translates for
    // a purpose.
    expect(Object.keys(catalog).sort()).toEqual([...REASONS].sort())
  })

  it('falls back to the raw message for anything else', () => {
    // A 403 the guard did not raise, a network fault, a reason a newer backend knows and this
    // build does not: the backend's own prose is the honest last resort, not a wrong translation.
    expect(moveRefusalKey(refused('some_future_reason'))).toBeNull()
    expect(moveRefusalKey({ body: { error: { code: 'forbidden' } } })).toBeNull()
    expect(moveRefusalKey(new Error('Network down'))).toBeNull()
  })
})
