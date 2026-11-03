// The reports the engine writes onto a step, which each report's own component shows and every
// result window repeats in its footer (`ResultWindowShell`): the agent's effort rating, the
// pre-PR validation of the service's checks, and the bugfix reproduction proof. The commands,
// the outputs and the ratings are made up.
import type {
  AgentEffortReport,
  ReproductionReport,
  ValidationReport,
} from '@cat-factory/contracts'

/** A coder's rating of the login work: moderate, with one obstacle. */
export const effortReport: AgentEffortReport = {
  difficulty: 6,
  summary: 'Straightforward once the session store was understood. Two tests needed rewriting.',
  obstacles: ['No fixture for an expired refresh token'],
}

/** One check the harness ran, 4.2 s long; a failed one exits 1 unless `extra` says otherwise. */
export function validationCheck(
  label: string,
  command: string,
  passed: boolean,
  extra: Partial<ValidationReport['outcomes'][number]> = {},
): ValidationReport['outcomes'][number] {
  return {
    label,
    command,
    passed,
    exitCode: passed ? 0 : 1,
    durationMs: 4200,
    ...extra,
  }
}

/** Typecheck, lint and test, all green on the first attempt of three. */
export const validationPassed: ValidationReport = {
  passed: true,
  attempts: 1,
  maxAttempts: 3,
  at: Date.UTC(2026, 9, 11, 9, 32, 0),
  outcomes: [
    validationCheck('typecheck', 'pnpm typecheck', true),
    validationCheck('lint', 'pnpm lint', true),
    validationCheck('test', 'pnpm test:run', true),
  ],
}

/** The test check still failing after the last attempt, with its output tail. */
export const validationFailed: ValidationReport = {
  passed: false,
  attempts: 3,
  maxAttempts: 3,
  at: Date.UTC(2026, 9, 11, 9, 32, 0),
  outcomes: [
    validationCheck('typecheck', 'pnpm typecheck', true),
    validationCheck('test', 'pnpm test:run', false, {
      outputTail:
        'FAIL app/stores/session.spec.ts > revokes on expiry\n  expected 0 calls, got 1\n\n Tests  1 failed | 48 passed',
    }),
  ],
}

/** The refresh bug reproduced: the check failed before the fix and passes after it. */
export function reproductionReport(
  overrides: Partial<ReproductionReport> = {},
): ReproductionReport {
  return {
    status: 'reproduced',
    command: 'pnpm vitest run test/refresh.spec.ts',
    testPaths: ['test/refresh.spec.ts'],
    base: {
      exitCode: 1,
      passed: false,
      durationMs: 8_400,
      outputTail:
        ' FAIL  test/refresh.spec.ts > refresh > answers 401 for an expired token\n' +
        'AssertionError: expected 500 to be 401',
    },
    final: {
      exitCode: 0,
      passed: true,
      durationMs: 8_100,
      outputTail: ' ✓ test/refresh.spec.ts (4)',
    },
    attempts: 1,
    maxAttempts: 2,
    at: Date.UTC(2026, 9, 11, 10, 20),
    ...overrides,
  }
}
