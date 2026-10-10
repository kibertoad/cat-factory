import { describe, expect, it } from 'vitest'
import { perPersonPrefixInvocation, resetInvocation, resumeInvocation } from '../src/identity.ts'

// The three commands this suite prints, each pinned for the one edge case that undoes the point of
// it: a run id holding a space or a quote, and a command spelled for a shell the operator is not
// holding. The kit's own text helpers (the describers, the quoting, the dialect table these render
// through) are tested in `@cat-factory/acceptance-kit`.

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
