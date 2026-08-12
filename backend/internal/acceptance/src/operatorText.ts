// How this suite renders a value INTO text an operator reads: a thrown value, an address, and the
// commands they are expected to paste.
//
// Every helper here is here because it was written more than once. The suite's whole premise is that
// a refusal is worth more than a failure, which makes each of these strings a deliverable rather than
// a log line, and the mistakes below are the ones that quietly take the value back out of them: a
// chain with nothing to say, a credential printed beside the steps, a value that breaks the command
// it was interpolated into, and a command spelled for a shell the operator is not holding.
//
// The last of those is owned here COMPLETELY: every shell dialect this suite prints is decided in the
// one `DIALECTS` table, and a call site says what it needs rather than which shell is in play.

import { getErrorMessage, redactSecrets } from '@cat-factory/kernel'

/**
 * A thrown value as text, with the ONE fallback for a chain that said nothing.
 *
 * `getErrorMessage` reads the whole cause chain (which is why nothing here rolls its own
 * `error instanceof Error ? error.message : String(error)`; see `probeFailure.ts` for what that
 * costs), and it answers EMPTY for an error with nothing to say. That is deliberate on its part and
 * it is what this fallback is for: interpolated bare, an empty answer renders as `could not be read
 * ()`, which states less than naming the absence. One helper rather than the phrase re-invented at
 * each site, so the sentence a reader sees for an undescribable failure is one sentence.
 */
export function describeThrown(error: unknown): string {
  return getErrorMessage(error) || 'no reason reported'
}

/**
 * A value as it may be PRINTED: scrubbed.
 *
 * A base URL may legitimately carry userinfo (`https://svc:secret@backend.example.com`), which no
 * URL policy rejects, and every string this suite builds from one is thrown out of `beforeAll` and
 * printed to a console. kernel scrubs the target inside its own hints for exactly this reason, and
 * it scrubs an error chain on the way out; a value that came from THIS suite's config or from a
 * response body gets neither, so it is scrubbed at the emit site instead.
 */
export function scrubbed(value: string): string {
  return redactSecrets(value) ?? value
}

/**
 * A value as ONE single-quoted shell word, scrubbed, and safe whatever it holds.
 *
 * The scrub is the same one as above: these commands are printed beside the steps. The quoting is
 * the other half, and it is not theoretical for a value a human typed into a `.env`: a raw
 * interpolation into `'…'` breaks the whole command the moment the value holds a quote of its own,
 * and a remedy whose command does not parse is worse than one with no command, because it is
 * offered as the thing to run. POSIX has no escape inside single quotes, so the closing quote is
 * the escape: `'` becomes `'\''`.
 */
export function shellQuoted(value: string): string {
  return `'${scrubbed(value).replaceAll("'", `'\\''`)}'`
}

/** The command that runs a pass, in one place, so a printed remedy cannot drift from the README. */
const ACCEPTANCE_INVOCATION = 'pnpm --filter @cat-factory/acceptance run acceptance'

/** Same, for the command that clears a board back to "before any pass ran" (`src/reset.ts`). */
const RESET_INVOCATION = 'pnpm --filter @cat-factory/acceptance run reset'

/** Which shell will RECEIVE the text. It decides every spelling in the table below. */
export type ShellFlavour = 'posix' | 'powershell'

/**
 * The shell the operator is HOLDING, which the platform only approximates.
 *
 * Git Bash, MSYS and Cygwin are ordinary places to drive this suite from on Windows (this
 * repository's own tooling documents the first), and in one of those the PowerShell form is worse
 * than the POSIX form it would replace: bash expands `$env:ACCEPTANCE_RUN_ID` to nothing, answers
 * `=: command not found`, and never reaches the command, so a printed RESUME silently starts a
 * second pass instead. Those shells all export `SHELL` or `MSYSTEM`; PowerShell and `cmd.exe` export
 * neither. `PSModulePath` is deliberately not consulted in the other direction: Windows sets it
 * machine-wide, so it is present inside Git Bash too and would prove nothing.
 *
 * **So `cmd.exe` reads as `powershell` here, and that is a limit rather than a decision.** Nothing
 * in the environment separates the two: `PSModulePath` and `ComSpec` are set in both, and `PROMPT`
 * (cmd's own) is INHERITED by a PowerShell started from a cmd window, so keying on it would hand
 * `&&` to Windows PowerShell 5.1, which cannot parse it at all. Guessing wrong in that direction is
 * the worse failure of the two, because the PowerShell form pasted into cmd fails loudly and
 * immediately at the first token. What follows from the limit is that nothing may SEND an operator
 * to cmd.exe: `personalUnlock.ts`'s echo refusal used to list it among the terminals to switch to,
 * which would have fixed one prompt and broken every command printed after it.
 */
export function shellFlavour(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): ShellFlavour {
  if (platform !== 'win32') return 'posix'
  return env.SHELL || env.MSYSTEM ? 'posix' : 'powershell'
}

/** A literal for a POSIX `"…"`, where `$`, `` ` `` and `\` all still act unless escaped. */
function posixInDoubleQuotes(value: string): string {
  return scrubbed(value).replaceAll(/([\\"$`])/g, '\\$1')
}

/** The same for PowerShell's `"…"`, whose escape character is the BACKTICK rather than `\`. */
function powerShellInDoubleQuotes(value: string): string {
  return scrubbed(value).replaceAll(/([`"$])/g, '`$1')
}

/**
 * Everything the two shells spell differently, in ONE table.
 *
 * A renderer below states WHAT it needs (a literal, a username substitution, an assignment that
 * outlives the command or one that does not) and never which shell is in play. That is not tidying:
 * `VAR=value command` was hard-coded at five sites, and the three that were missed on the first pass
 * were missed because converting one cost a new function carrying its own copy of the same two
 * decisions. Adding a sixth site now costs a call.
 */
type Dialect = {
  /** A value as ONE word, with nothing inside it left expandable. */
  literal: (value: string) => string
  /** A value followed by the operator's username, which is a SUBSTITUTION and must stay live. */
  withUsername: (value: string) => string
  /** An assignment that PERSISTS for the rest of the shell session. */
  assign: (name: string, rendered: string) => string
  /** An assignment scoped to ONE command, for a value that must not outlive it. */
  assignFor: (name: string, rendered: string, command: string) => string
}

const DIALECTS: Record<ShellFlavour, Dialect> = {
  posix: {
    literal: shellQuoted,
    withUsername: (value) => `"${posixInDoubleQuotes(value)}-$(whoami)"`,
    assign: (name, rendered) => `export ${name}=${rendered}`,
    assignFor: (name, rendered, command) => `${name}=${rendered} ${command}`,
  },
  powershell: {
    // PowerShell's single-quoted string DOUBLES a literal quote rather than escaping it.
    literal: (value) => `'${scrubbed(value).replaceAll("'", "''")}'`,
    withUsername: (value) => `"${powerShellInDoubleQuotes(value)}-$env:USERNAME"`,
    assign: (name, rendered) => `$env:${name} = ${rendered}`,
    // `;` and not `&&`: Windows PowerShell 5.1 has no pipeline chain operators at all, and a pasted
    // `&&` fails to PARSE, which is a worse answer than running the second half unconditionally.
    //
    // The `finally` is what makes this an assignment FOR ONE COMMAND rather than one that merely
    // reads like it. `$env:` is the process environment, so it is not scoped by a block, a function
    // or a child scope: set and left, it silently resumes the finished pass on every later
    // invocation in that window, which is the exact cost this renderer's own contract exists to
    // avoid and which the POSIX prefix does not have. `try` rather than a trailing `;`, so the
    // variable is cleared when the pass is interrupted too, which is when a resume is most likely.
    assignFor: (name, rendered, command) =>
      `$env:${name} = ${rendered}; try { ${command} } finally { Remove-Item Env:${name} }`,
  },
}

/**
 * The invocation that RESUMES a pass, in the shell the operator is actually holding.
 *
 * `VAR=value command` is POSIX syntax, and this suite's most-printed command carried it everywhere:
 * both prerequisite remedies that offer a resume, the status report's closing line, and the note
 * `configure` writes into the `.env`. PowerShell has no inline environment prefix at all, so it
 * reads the assignment as the COMMAND NAME and answers `CommandNotFoundException`. That is a remedy
 * which does not parse, offered as the thing to run, and {@link shellQuoted} above exists against
 * exactly that failure. Windows is not an edge case here: the pass drives a deployment running on
 * the operator's own machine, and this suite was written on one.
 *
 * Two things it deliberately is not:
 *
 *   - **Not a `.env` line.** That is the platform-neutral way to carry the id and the steps say so,
 *     but a value in the file becomes the DEFAULT for every later pass, and the reason to print a
 *     command is that a resume is a ONE-OFF. Leaving a stale id in the file silently resumes a
 *     finished pass, which is the failure this suite's `latest` refusal already exists to prevent.
 *   - **Not `cmd.exe`'s `set VAR=… && …`.** One Windows dialect, chosen because it is the shell the
 *     repository's own tooling assumes; a third form would be two more strings to keep true.
 */
export function resumeInvocation(runId: string, flavour: ShellFlavour = shellFlavour()): string {
  const shell = DIALECTS[flavour]
  return shell.assignFor('ACCEPTANCE_RUN_ID', shell.literal(runId), ACCEPTANCE_INVOCATION)
}

/**
 * The invocation that CLEARS a board, in the two forms it is offered in.
 *
 * `apply: false` is the preview, which is what a remedy printed by a refusal offers first: this
 * deletes service frames, tasks and run history on a board somebody may share, so the reading an
 * operator does before the deletion is part of the design rather than caution (see `reset.ts`).
 *
 * Not a shell-dialect question at all, unlike {@link resumeInvocation}: no variable is being set, so
 * the same text works in every shell. It lives here anyway because it is a pasteable command, and
 * the one thing this module owns completely is that a command is spelled in ONE place: the reset is
 * named by two prerequisite remedies, the README and the command's own output.
 *
 * A NAMED pass widens what is cleared to whatever that pass's ledger holds, which is the form worth
 * printing beside a resume: the two are the same decision (continue this pass, or clear it) and an
 * operator choosing between them should not have to work out the second command's arguments.
 */
export function resetInvocation(options: { runId?: string; apply?: boolean } = {}): string {
  return [
    RESET_INVOCATION,
    ...(options.runId ? [options.runId] : []),
    ...(options.apply ? ['--yes'] : []),
  ].join(' ')
}

/**
 * A variable an operator sets and KEEPS, for a remedy whose whole fix is one value.
 *
 * The persistent twin of {@link resumeInvocation}, and the reason both live here: `export NAME=value`
 * is as POSIX-only as the inline prefix is, so the remedies that pointed a pass at a different
 * workspace, owner or ingress template were three more commands a PowerShell operator could not
 * paste. Quoted rather than bare, because the value comes from a deployment's own answer.
 */
export function envAssignment(
  name: string,
  value: string,
  flavour: ShellFlavour = shellFlavour(),
): string {
  const shell = DIALECTS[flavour]
  return shell.assign(name, shell.literal(value))
}

/**
 * Taking a per-person name prefix, so two operators share one board without colliding.
 *
 * The one command whose VALUE is not a literal: the username is a substitution, so it cannot ride
 * {@link envAssignment}'s single-quoted word, and the double-quoted string that keeps it live is also
 * the one place a shell still expands what came from the environment. `ACCEPTANCE_NAME_PREFIX` is
 * read verbatim from the operator's own `.env`, so the literal half is escaped for the dialect it
 * lands in: unescaped, a prefix holding `$(…)` (or a backtick, in either shell) is not a broken
 * command but a command that RUNS something else the moment it is pasted.
 */
export function perPersonPrefixInvocation(
  prefix: string,
  flavour: ShellFlavour = shellFlavour(),
): string {
  const shell = DIALECTS[flavour]
  return shell.assign('ACCEPTANCE_NAME_PREFIX', shell.withUsername(prefix))
}
