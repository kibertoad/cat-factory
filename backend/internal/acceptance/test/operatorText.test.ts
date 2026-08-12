import { describe, expect, it } from 'vitest'
import {
  describeThrown,
  envAssignment,
  perPersonPrefixInvocation,
  resetInvocation,
  resumeInvocation,
  scrubbed,
  shellFlavour,
  shellQuoted,
  thrownLocation,
} from '../src/operatorText.ts'

// Each of these is pinned here because each has exactly one edge case that undoes the point of it: a
// chain with nothing to say, a URL carrying a credential, a value holding the quote the command is
// built with, and a command printed in a shell that cannot parse it.

describe('describeThrown', () => {
  it('reads the WHOLE chain, not the outermost link', () => {
    // The reason nothing in this package rolls its own describer: on Node the outermost link of a
    // transport failure is the contentless `fetch failed`.
    const error = new TypeError('fetch failed', {
      cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8787'), {
        code: 'ECONNREFUSED',
      }),
    })
    expect(describeThrown(error)).toContain('connect ECONNREFUSED 127.0.0.1:8787')
  })

  it('names the absence for a chain that said nothing, rather than rendering empty', () => {
    // `getErrorMessage` answers EMPTY for an error with nothing to say, deliberately, so that a
    // call site's fallback stays reachable. Interpolated bare, that renders `(…)` around nothing.
    expect(describeThrown(new Error(''))).toBe('no reason reported')
  })

  it('reports a non-Error throw as itself, which is a fact worth having', () => {
    expect(describeThrown('the pool is closed')).toBe('the pool is closed')
    expect(describeThrown(null)).toBe('null')
  })
})

describe('thrownLocation', () => {
  it('answers the FRAMES, whatever the message did', () => {
    // Matched on their own `at ` shape rather than by cutting the message off the front of the stack:
    // a stack begins with as many lines as the message has, and this suite's refusals routinely run
    // to twenty, so anything that assumed one line would print the refusal a second time.
    const error = new Error('a refusal\nwith numbered steps\n  1. do this\n  2. then this')
    const location = thrownLocation(error)

    expect(location).not.toBeNull()
    expect(location).not.toContain('numbered steps')
    // Frames, plus at most the note the cap adds; nothing of the message.
    for (const line of location?.split('\n') ?? []) {
      expect(line.trim()).toMatch(/^(at |… \d+ more frame)/)
    }
  })

  it('caps the frames and SAYS what it dropped', () => {
    // The tail of a stack is Node's own module machinery; a reader who assumed the shown frames were
    // all of it would conclude the throw happened at top level.
    const error = new Error('deep')
    error.stack = [
      'Error: deep',
      ...Array.from({ length: 9 }, (_, at) => `    at frame${at}`),
    ].join('\n')

    const location = thrownLocation(error, 4)

    expect(location).toContain('at frame3')
    expect(location).not.toContain('at frame4')
    expect(location).toContain('5 more frame(s)')
  })

  it('says nothing for a value that has no stack to speak of', () => {
    // A thrown string, or an error a test hand-built: the caller prints the message alone rather than
    // an empty section under it.
    expect(thrownLocation('the pool is closed')).toBeNull()
    expect(thrownLocation(Object.assign(new Error('no stack'), { stack: undefined }))).toBeNull()
  })
})

describe('scrubbed', () => {
  it('removes a credential a base URL legitimately carries', () => {
    expect(scrubbed('https://svc:hunter2@backend.example.com')).toBe(
      'https://svc:[REDACTED]@backend.example.com',
    )
  })

  it('leaves an ordinary address exactly as it was typed', () => {
    expect(scrubbed('http://127.0.0.1:8787')).toBe('http://127.0.0.1:8787')
  })
})

describe('shellQuoted', () => {
  it('quotes as one word, so a path with a space stays one argument', () => {
    expect(shellQuoted('http://127.0.0.1:8787/a b')).toBe(`'http://127.0.0.1:8787/a b'`)
  })

  it('survives the quote it is built with, which would otherwise break the command', () => {
    // POSIX has no escape inside single quotes, so the closing quote is the escape. A remedy whose
    // command does not parse is worse than one with no command: it is offered as the thing to run.
    expect(shellQuoted("it's")).toBe(`'it'\\''s'`)
  })

  it('scrubs as well as quotes, since these commands are printed beside the steps', () => {
    expect(shellQuoted('https://svc:hunter2@backend.example.com/health')).toBe(
      `'https://svc:[REDACTED]@backend.example.com/health'`,
    )
  })
})

// What decides the dialect is the shell, and the platform only approximates it: a Windows operator
// in Git Bash is handed a PowerShell command that bash answers `=: command not found` to, and then
// starts a second pass with no run id rather than resuming.
describe('shellFlavour', () => {
  it('reads the shell, not the platform, on Windows', () => {
    expect(shellFlavour('win32', {})).toBe('powershell')
    expect(shellFlavour('win32', { SHELL: '/usr/bin/bash' })).toBe('posix')
    expect(shellFlavour('win32', { MSYSTEM: 'MINGW64' })).toBe('posix')
  })

  it('ignores `PSModulePath`, which Windows sets machine-wide and Git Bash inherits', () => {
    expect(shellFlavour('win32', { PSModulePath: 'C:\\Program Files\\PowerShell\\Modules' })).toBe(
      'powershell',
    )
    expect(
      shellFlavour('win32', { PSModulePath: 'C:\\pwsh\\Modules', SHELL: '/usr/bin/bash' }),
    ).toBe('posix')
  })

  it('never asks anywhere else, since only Windows has a shell this choice is open on', () => {
    expect(shellFlavour('linux', { PSModulePath: 'whatever' })).toBe('posix')
    expect(shellFlavour('darwin', {})).toBe('posix')
  })
})

// Each renderer is asserted for BOTH dialects with an explicit flavour, so the PowerShell form is
// covered by the Linux CI lane that would otherwise never execute it, and the POSIX form stays
// covered when the suite itself is run from Windows.
describe('resumeInvocation', () => {
  it('carries the id as an inline prefix on POSIX', () => {
    expect(resumeInvocation('20260809175530', 'posix')).toBe(
      `ACCEPTANCE_RUN_ID='20260809175530' pnpm --filter @cat-factory/acceptance run acceptance`,
    )
  })

  it('assigns before the command in PowerShell, where an inline prefix is not a command at all', () => {
    // PowerShell reads `ACCEPTANCE_RUN_ID=latest pnpm …` as the name of a command to look up and
    // answers CommandNotFoundException, so the POSIX form is a remedy that cannot be pasted. The
    // separator is `;` rather than `&&`, which Windows PowerShell 5.1 cannot parse at all. Asserted
    // as the WHOLE string, because "does not contain `&&`" is equally true of a command that sets
    // the variable and never runs the pass.
    expect(resumeInvocation('latest', 'powershell')).toBe(
      `$env:ACCEPTANCE_RUN_ID = 'latest'; try { pnpm --filter @cat-factory/acceptance run ` +
        `acceptance } finally { Remove-Item Env:ACCEPTANCE_RUN_ID }`,
    )
  })

  it('clears the variable afterwards, so a RESUME does not outlive the pass it resumed', () => {
    // The half that makes this a scoped assignment rather than one that merely reads like the POSIX
    // prefix it replaces. `$env:` is the PROCESS environment: no block, function or child scope
    // narrows it, so set and left it silently resumes a finished pass on every later invocation in
    // that window, which is the failure `resumeInvocation` refuses to print a `.env` line for.
    // `finally` rather than a trailing `;`, because an interrupted pass is when a resume is likeliest.
    expect(resumeInvocation('latest', 'powershell')).toContain(
      'finally { Remove-Item Env:ACCEPTANCE_RUN_ID }',
    )
    // The POSIX prefix has that lifetime built in, so it gains nothing and stays one command.
    expect(resumeInvocation('latest', 'posix')).not.toContain('unset')
  })

  it('quotes each shell the way that shell escapes, for an id holding a quote', () => {
    // Neither dialect escapes inside single quotes: POSIX ends and reopens them, PowerShell doubles
    // the quote. A run id should never hold one, which is exactly why nothing would catch this.
    expect(resumeInvocation("it's", 'posix')).toContain(`ACCEPTANCE_RUN_ID='it'\\''s'`)
    expect(resumeInvocation("it's", 'powershell')).toContain(`$env:ACCEPTANCE_RUN_ID = 'it''s'`)
  })
})

describe('resetInvocation', () => {
  it('previews by default, and only deletes when the flag is asked for', () => {
    // The default form is the one printed by a refusal, so it must be the harmless one: this deletes
    // service frames, their tasks and their run history on a board somebody may share.
    expect(resetInvocation()).toBe('pnpm --filter @cat-factory/acceptance run reset')
    expect(resetInvocation({ apply: true })).toBe(
      'pnpm --filter @cat-factory/acceptance run reset --yes',
    )
  })

  it('carries a named pass before the flag, so the clear covers what a resume would have continued', () => {
    expect(resetInvocation({ runId: '20260809175530', apply: true })).toBe(
      'pnpm --filter @cat-factory/acceptance run reset 20260809175530 --yes',
    )
  })

  it('carries the scope flag too, so a printed apply deletes what the preview showed', () => {
    // The command the preview prints back is the one an operator pastes. Dropping `--all` there would
    // narrow the target silently, and the narrower run reports success over a different set.
    expect(resetInvocation({ all: true })).toBe(
      'pnpm --filter @cat-factory/acceptance run reset --all',
    )
    expect(resetInvocation({ runId: 'latest', all: true, apply: true })).toBe(
      'pnpm --filter @cat-factory/acceptance run reset latest --all --yes',
    )
  })

  it('sets no variable, so an ordinary run id needs no dialect and is printed bare', () => {
    // Unlike a resume, which spells `VAR=value command` differently per shell: pnpm forwards the
    // positional and the flag identically in both, so a minted id (a timestamp) reads as itself.
    expect(resetInvocation({ runId: 'latest' })).not.toContain('$env:')
    expect(resetInvocation({ runId: 'latest' })).not.toContain('export ')
    expect(resetInvocation({ runId: '20260809175530' }, 'powershell')).toBe(
      'pnpm --filter @cat-factory/acceptance run reset 20260809175530',
    )
  })

  it('QUOTES a run id that is not one shell word, in the dialect the operator is holding', () => {
    // A pass is identified by its FILE NAME and a hand-named one is supported ('friday-rerun' is
    // `passFiles.ts`'s own example), so a space is representable. Bare, the printed remedy is
    // refused by its own parser ("'friday' and 'rerun' both name a pass"), and a quote breaks the
    // pasted line outright: a command that does not parse is worse than no command, which is the
    // rule `shellQuoted` exists for.
    expect(resetInvocation({ runId: 'friday rerun', apply: true }, 'posix')).toBe(
      "pnpm --filter @cat-factory/acceptance run reset 'friday rerun' --yes",
    )
    // POSIX has no escape inside single quotes; PowerShell DOUBLES the quote instead.
    expect(resetInvocation({ runId: "o'clock" }, 'posix')).toContain(`'o'\\''clock'`)
    expect(resetInvocation({ runId: "o'clock" }, 'powershell')).toContain(`'o''clock'`)
  })
})

describe('envAssignment', () => {
  it('states the assignment the way the receiving shell spells it', () => {
    expect(envAssignment('ACCEPTANCE_WORKSPACE_ID', 'ws_1', 'posix')).toBe(
      `export ACCEPTANCE_WORKSPACE_ID='ws_1'`,
    )
    // PowerShell has no `export` at all: it answers `CommandNotFoundException: export`, the same
    // failure as the inline prefix and for the same reason.
    expect(envAssignment('ACCEPTANCE_WORKSPACE_ID', 'ws_1', 'powershell')).toBe(
      `$env:ACCEPTANCE_WORKSPACE_ID = 'ws_1'`,
    )
  })

  it('quotes the value, which comes from a deployment answer and not from a constant', () => {
    expect(envAssignment('X', "it's", 'posix')).toBe(`export X='it'\\''s'`)
    expect(envAssignment('X', "it's", 'powershell')).toBe(`$env:X = 'it''s'`)
  })
})

describe('perPersonPrefixInvocation', () => {
  it('substitutes the username the way each shell spells it', () => {
    expect(perPersonPrefixInvocation('cf-acc', 'posix')).toBe(
      'export ACCEPTANCE_NAME_PREFIX="cf-acc-$(whoami)"',
    )
    expect(perPersonPrefixInvocation('cf-acc', 'powershell')).toBe(
      '$env:ACCEPTANCE_NAME_PREFIX = "cf-acc-$env:USERNAME"',
    )
  })

  // The username has to stay a live substitution, so this is the one value that cannot be quoted as
  // a word, and a double-quoted string is where BOTH shells still expand what is inside it.
  // `ACCEPTANCE_NAME_PREFIX` is read verbatim from the operator's own `.env` and validated nowhere.
  it('neutralises a prefix that would otherwise RUN when the remedy is pasted', () => {
    expect(perPersonPrefixInvocation('x$(id)', 'posix')).toBe(
      'export ACCEPTANCE_NAME_PREFIX="x\\$(id)-$(whoami)"',
    )
    expect(perPersonPrefixInvocation('x$(Get-Content ~/.ssh/id_rsa)', 'powershell')).toBe(
      '$env:ACCEPTANCE_NAME_PREFIX = "x`$(Get-Content ~/.ssh/id_rsa)-$env:USERNAME"',
    )
  })

  it('survives a prefix holding the quote the command is built with', () => {
    expect(perPersonPrefixInvocation('a"b', 'posix')).toBe(
      'export ACCEPTANCE_NAME_PREFIX="a\\"b-$(whoami)"',
    )
    expect(perPersonPrefixInvocation('a"b', 'powershell')).toBe(
      '$env:ACCEPTANCE_NAME_PREFIX = "a`"b-$env:USERNAME"',
    )
  })

  it('escapes the escape character each shell uses inside a double-quoted string', () => {
    // A backslash is literal in PowerShell and an escape in POSIX; a backtick is the reverse.
    expect(perPersonPrefixInvocation('a\\b', 'posix')).toBe(
      'export ACCEPTANCE_NAME_PREFIX="a\\\\b-$(whoami)"',
    )
    expect(perPersonPrefixInvocation('a`b', 'powershell')).toBe(
      '$env:ACCEPTANCE_NAME_PREFIX = "a``b-$env:USERNAME"',
    )
  })
})
