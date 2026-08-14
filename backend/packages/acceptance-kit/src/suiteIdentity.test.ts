import { describe, expect, it } from 'vitest'
import {
  leftInPlaceNote,
  resumeCommand,
  type SuiteIdentity,
  suiteCommand,
} from './suiteIdentity.js'

// The commands a kit prints on somebody else's behalf, which is the pair of mistakes this module
// exists against: a remedy naming a variable the consumer's suite does not read, and one spelled for
// a shell the operator is not holding. Both are silent, and both are offered as the thing to run.
//
// The dialects themselves are `operatorText.test.ts`. What is pinned here is that these renderers go
// THROUGH them for the values that need it and leave alone the values that do not, since a remedy
// quoting what needs no quoting reads as a command with something odd about it.

/** A suite, as one declares itself: deliberately not this repository's, whose spellings would pass anyway. */
const identity: SuiteIdentity = {
  name: '@acme/acceptance',
  runCommand: 'pnpm --filter @acme/acceptance run acceptance',
  runIdVariable: 'ACME_RUN_ID',
  baseUrlVariable: 'ACME_BASE_URL',
  configFile: 'acceptance/.env',
  statusCommand: (runId) => `pnpm --filter @acme/acceptance run status ${runId}`,
}

describe('resumeCommand', () => {
  it('carries the id as an inline prefix on POSIX', () => {
    expect(resumeCommand(identity, '20260809175530', 'posix')).toBe(
      `ACME_RUN_ID='20260809175530' pnpm --filter @acme/acceptance run acceptance`,
    )
  })

  it('assigns before the command in PowerShell, where an inline prefix is not a command at all', () => {
    // `VAR=value command` is POSIX syntax that PowerShell reads as the name of a command to look up,
    // answering CommandNotFoundException. Asserted as the WHOLE string, because "does not contain
    // `&&`" is equally true of a command that sets the variable and never runs the pass, and because
    // the `finally` is what keeps the assignment from outliving the pass it resumed.
    expect(resumeCommand(identity, 'latest', 'powershell')).toBe(
      `$env:ACME_RUN_ID = 'latest'; try { pnpm --filter @acme/acceptance run acceptance } ` +
        `finally { Remove-Item Env:ACME_RUN_ID }`,
    )
  })

  it('QUOTES the id whatever it holds, since this half is an assignment', () => {
    // Unlike `suiteCommand`'s positional: a bare value in an assignment is one shell-special
    // character away from assigning something else entirely. A run id is a FILE NAME and a
    // hand-named pass is supported, so a space and a quote are both representable.
    expect(resumeCommand(identity, 'friday rerun', 'posix')).toContain(`ACME_RUN_ID='friday rerun'`)
    // Neither dialect escapes inside single quotes: POSIX ends and reopens them, PowerShell doubles.
    expect(resumeCommand(identity, "it's", 'posix')).toContain(`ACME_RUN_ID='it'\\''s'`)
    expect(resumeCommand(identity, "it's", 'powershell')).toContain(`$env:ACME_RUN_ID = 'it''s'`)
  })
})

describe('suiteCommand', () => {
  /** The shape an identity's `statusCommand` / `resetCommand` takes: the suite's own invocation. */
  const status = (runId: string) => `pnpm --filter @acme/acceptance run status ${runId}`

  it("renders the SUITE's own command around the id, bare for an ordinary one", () => {
    // A minted id is a timestamp, and a remedy that quotes what needs no quoting reads as a command
    // with something odd about it.
    expect(suiteCommand(status, '20260809175530', 'posix')).toBe(
      'pnpm --filter @acme/acceptance run status 20260809175530',
    )
    expect(suiteCommand(status, '20260809175530', 'powershell')).toBe(
      'pnpm --filter @acme/acceptance run status 20260809175530',
    )
  })

  it('quotes an id that is not one shell word, in the dialect the operator is holding', () => {
    // Bare, a hand-named pass is refused by the command's own parser ("'friday' and 'rerun' both
    // name a pass"), and one holding a quote breaks the pasted line outright.
    expect(suiteCommand(status, 'friday rerun', 'posix')).toBe(
      `pnpm --filter @acme/acceptance run status 'friday rerun'`,
    )
    expect(suiteCommand(status, "o'clock", 'posix')).toContain(`'o'\\''clock'`)
    expect(suiteCommand(status, "o'clock", 'powershell')).toContain(`'o''clock'`)
  })
})

describe('leftInPlaceNote', () => {
  it("names the consumer's OWN resume variable, since that is the whole point of the seam", () => {
    const note = leftInPlaceNote(identity)
    expect(note).toContain('Nothing was cleaned up')
    expect(note).toContain('ACME_RUN_ID')
    // No command, deliberately: this tail rides a wait that expired and a refused probe alike, and
    // the resume there is rendered by whoever prints the run id it has to carry.
    expect(note).not.toContain('$env:')
  })
})
