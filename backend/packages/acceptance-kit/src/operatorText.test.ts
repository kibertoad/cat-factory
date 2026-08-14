import { describe, expect, it } from 'vitest'
import {
  assignFor,
  describeThrown,
  envAssignment,
  perPersonAssignment,
  scrubbed,
  shellFlavour,
  shellLiteral,
  shellQuoted,
  shellWord,
  thrownLocation,
} from './operatorText.js'

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
    // The message is cut off the front by its own CONTENT, never by counting lines: a stack begins
    // with as many lines as the message has, and this suite's refusals routinely run to twenty, so
    // anything that assumed one line would print the refusal a second time.
    const error = new Error('a refusal\nwith numbered steps\n  1. do this\n  2. then this')
    const location = thrownLocation(error)

    expect(location).not.toBeNull()
    expect(location).not.toContain('numbered steps')
    // Frames, plus at most the note the cap adds; nothing of the message.
    for (const line of location?.split('\n') ?? []) {
      expect(line.trim()).toMatch(/^(at |… \d+ more frame)/)
    }
  })

  it('does not lift a line of the MESSAGE out as though it were a frame', () => {
    // The reason the message is cut by content rather than scanned past. These refusals are numbered
    // remedies, pasted command blocks and provider error bodies folded into the chain, so an
    // indented line beginning `at ` is ordinary prose. Read as a frame it is rendered under the
    // failure as a location that does not exist, AND printed twice, having already appeared in the
    // message immediately above.
    const error = new Error(
      'the cluster refused the ServiceAccount:\n' +
        '    at least one binding is missing\n' +
        '  1. kubectl auth can-i --list',
    )

    const location = thrownLocation(error)

    expect(location).not.toContain('at least one binding')
    expect(location).toMatch(/at \S+/)
  })

  it('falls back to the whole stack when the stack does not carry the message', () => {
    // A subclass that rebuilt its own stack, or a hand-assembled one: there is no message region to
    // cut, so every `at ` line is a frame and the previous behaviour is the right one.
    const error = Object.assign(new Error('rebuilt'), {
      stack: ['SomethingElse: different text', '    at frame0', '    at frame1'].join('\n'),
    })

    expect(thrownLocation(error)).toContain('at frame0')
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

describe('assignFor', () => {
  it('scopes the assignment to ONE command, which each shell spells differently', () => {
    // The distinction that makes this a different renderer from `envAssignment` rather than a
    // formatting variant of it. `$env:` is the PROCESS environment: no block, function or child scope
    // narrows it, so set and left it silently resumes a finished pass on every later invocation in
    // that window. `try/finally` rather than a trailing `;`, because an interrupted pass is when a
    // resume is likeliest, and `;` rather than `&&`, which Windows PowerShell 5.1 cannot parse.
    expect(assignFor('X', `'v'`, 'run it', 'posix')).toBe(`X='v' run it`)
    expect(assignFor('X', `'v'`, 'run it', 'powershell')).toBe(
      `$env:X = 'v'; try { run it } finally { Remove-Item Env:X }`,
    )
  })
})

describe('shellLiteral', () => {
  it('renders one word per dialect, which escape a quote in opposite ways', () => {
    // POSIX has no escape inside single quotes, so the closing quote IS the escape; PowerShell
    // doubles the quote instead. A value rendered with the wrong rule breaks the pasted command.
    expect(shellLiteral('a b', 'posix')).toBe(`'a b'`)
    expect(shellLiteral("it's", 'posix')).toBe(`'it'\\''s'`)
    expect(shellLiteral("it's", 'powershell')).toBe(`'it''s'`)
  })

  it('scrubs, since a rendered word is printed beside the steps', () => {
    expect(shellLiteral('https://svc:hunter2@backend.example.com', 'posix')).not.toContain(
      'hunter2',
    )
  })
})

describe('shellWord', () => {
  it('leaves an ordinary value bare and quotes one that is not a single word', () => {
    // A remedy that quotes what needs no quoting reads as a command with something odd about it, and
    // a bare value holding a space is a command whose own parser refuses it.
    expect(shellWord('20260809175530', 'posix')).toBe('20260809175530')
    expect(shellWord('friday-rerun.2', 'powershell')).toBe('friday-rerun.2')
    expect(shellWord('friday rerun', 'posix')).toBe(`'friday rerun'`)
    expect(shellWord("o'clock", 'powershell')).toBe(`'o''clock'`)
  })
})

describe('perPersonAssignment', () => {
  it('keeps the username a live SUBSTITUTION, which is why it cannot be a quoted word', () => {
    expect(perPersonAssignment('ACME_NAME_PREFIX', 'acme', 'posix')).toBe(
      'export ACME_NAME_PREFIX="acme-$(whoami)"',
    )
    expect(perPersonAssignment('ACME_NAME_PREFIX', 'acme', 'powershell')).toBe(
      '$env:ACME_NAME_PREFIX = "acme-$env:USERNAME"',
    )
  })

  it('neutralises a prefix that would otherwise RUN when the remedy is pasted', () => {
    // The double-quoted string that keeps the username live is also the one place a shell still
    // expands what came from the environment, and the prefix is read verbatim from a config file.
    expect(perPersonAssignment('X', 'a$(id)', 'posix')).toBe('export X="a\\$(id)-$(whoami)"')
    expect(perPersonAssignment('X', 'a$(id)', 'powershell')).toBe(
      '$env:X = "a`$(id)-$env:USERNAME"',
    )
  })

  it('escapes the escape character each shell uses inside a double-quoted string', () => {
    // A backslash is literal in PowerShell and an escape in POSIX; a backtick is the reverse.
    expect(perPersonAssignment('X', 'a\\b', 'posix')).toBe('export X="a\\\\b-$(whoami)"')
    expect(perPersonAssignment('X', 'a`b', 'powershell')).toBe('$env:X = "a``b-$env:USERNAME"')
  })
})
