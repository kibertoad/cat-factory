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

import { errorChainText, getErrorMessage, redactSecrets } from '@cat-factory/kernel'

/**
 * A thrown value as text, with the ONE fallback for a chain that said nothing.
 *
 * `getErrorMessage` reads the whole cause chain (which is why nothing here rolls its own
 * `error instanceof Error ? error.message : String(error)`; see `probeFailure.ts` for what that
 * costs), and it answers EMPTY for an error with nothing to say. That is deliberate on its part and
 * it is what this fallback is for: interpolated bare, an empty answer renders as `could not be read
 * ()`, which states less than naming the absence. One helper rather than the phrase re-invented at
 * each site, so the sentence a reader sees for an undescribable failure is one sentence.
 *
 * For a failure that is INTERPOLATED into a sentence, which is every caller here except the two that
 * print a refusal whole. Those take {@link describeFailure}, because this one carries kernel's
 * 400-character human budget.
 */
export function describeThrown(error: unknown): string {
  return getErrorMessage(error) || 'no reason reported'
}

/**
 * Cap on a refusal printed WHOLE to this pass's console.
 *
 * kernel keeps two budgets because its readers do (a 400-character one for a toast or a persisted
 * `reason`, 4,000 for a log field), and this is a third reader: a terminal, or the file an
 * afternoon-long pass was piped into. Almost everything that reaches it is a refusal this suite
 * AUTHORED and every line of it is instructions, so the budgets above are the wrong ones by an order
 * of magnitude: a preflight naming fourteen prerequisites with their numbered remedies runs to
 * thousands of characters, and cut at 400 an operator gets the first two and no fix for either. It is
 * still capped rather than unbounded, because a link of the chain can be a provider's HTML error
 * page, and kernel's cap states what it dropped.
 */
export const MAX_PRINTED_FAILURE_CHARS = 20_000

/**
 * A thrown value as the WHOLE refusal, for the two places that print one as the entire output: the
 * pass's own failure report (`scenarioRunner.ts`) and the refusals that stop it before it opens
 * (`runAcceptance.ts`).
 *
 * Its own function rather than a parameter on {@link describeThrown}, so the choice of reader is made
 * once per site by NAME. Getting it wrong is silent in the direction that matters: a truncated
 * refusal reads as a complete one, which is how a remedy an operator never saw becomes "the suite
 * didn't say".
 */
export function describeFailure(error: unknown): string {
  return errorChainText(error, MAX_PRINTED_FAILURE_CHARS) || 'no reason reported'
}

/**
 * A thrown value as the whole refusal, with the developer's half under it.
 *
 * The message chain comes first and is the whole message for everything this suite throws on
 * purpose: a preflight refusal, a deadline naming its last observation, a graded claim list. Those
 * are deliverables rather than log lines, so they are rendered through {@link describeFailure} (the
 * TERMINAL budget) rather than the 400-character one a toast reads, and a stack over the top of one
 * is noise.
 *
 * The frames come second and are for the other kind of failure, a bug in the suite itself, where
 * `Cannot read properties of undefined` with no location is an afternoon of guessing. Vitest printed
 * both; so does this, at both of the two places that report an unexpected throw (a scenario's, in
 * `scenarioRunner.ts`, and the pass's own, in `runAcceptance.ts`).
 */
export function failureWithLocation(error: unknown): string {
  const location = thrownLocation(error)
  return location ? `${describeFailure(error)}\n\n${location}` : describeFailure(error)
}

/**
 * Where a thrown value came FROM, capped, or null when it says nothing about that.
 *
 * The sibling of {@link describeThrown} and the answer to a different reader. Everything this suite
 * throws on purpose is a deliverable (a preflight refusal with numbered steps, a deadline naming its
 * last observation), and for those the message is the whole message. The other kind of failure is a
 * bug in the suite, where the message is `Cannot read properties of undefined` and the only useful
 * thing is the file and line: vitest printed a stack under every failure, and dropping it with the
 * framework would have made that class of failure an afternoon of guessing.
 *
 * The FRAMES only, and the message is cut off the front BY ITS OWN CONTENT rather than by counting
 * lines. V8 builds a stack as `${name}: ${message}` followed by the frames, so the end of
 * `error.message` is exactly where the frames may begin; a fixed number of header lines is the thing
 * that cannot be assumed, because this suite's messages routinely run to twenty.
 *
 * Scanning the WHOLE stack for `at ` was the same assumption wearing a safer face. These messages
 * are numbered remedies, pasted command blocks and folded-in provider error bodies, so a line of one
 * beginning with whitespace and `at ` is ordinary prose: lifted out, it is rendered under the failure
 * as though it were a frame AND printed a second time, having already appeared in the message above.
 * A message the stack does not carry (a subclass that rebuilt it) falls back to the whole string,
 * which is no worse than before.
 *
 * Capped, and the cap SAYS what it dropped: the tail of a stack is Node's own module machinery, and a
 * reader who assumed the six frames were all of it would conclude the throw happened at top level.
 */
export function thrownLocation(error: unknown, limit = 6): string | null {
  const stack = error instanceof Error ? error.stack : undefined
  if (!stack) return null
  const messageEnd = error instanceof Error ? endOfMessage(stack, error.message) : 0
  const frames = stack
    .slice(messageEnd)
    .split('\n')
    .filter((line) => /^\s+at /.test(line))
  if (frames.length === 0) return null
  const shown = frames.slice(0, limit).map((frame) => `  ${frame.trim()}`)
  const dropped = frames.length - shown.length
  return [...shown, ...(dropped > 0 ? [`  … ${dropped} more frame(s)`] : [])].join('\n')
}

/**
 * Where the message region of a stack ENDS, or 0 when this stack does not carry the message.
 *
 * `indexOf` rather than a length arithmetic on the `Name: ` prefix: an error's `name` is writable
 * and a cause chain re-renders, so the offset of the message is not something to compute. An empty
 * message matches at 0 and correctly cuts nothing.
 */
function endOfMessage(stack: string, message: string): number {
  const at = stack.indexOf(message)
  return at === -1 ? 0 : at + message.length
}

/**
 * A value as it may be PRINTED: scrubbed.
 *
 * A base URL may legitimately carry userinfo (`https://svc:secret@backend.example.com`), which no
 * URL policy rejects, and every string this suite builds from one is thrown out of a refusal and
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
 * No variable is being set, unlike {@link resumeInvocation}, so the command needs no dialect of its
 * own until a value goes into it. A run id is a FILE NAME and a hand-named pass is supported
 * ('friday-rerun' is `passFiles.ts`'s own example), so one holding a space renders a command whose
 * own parser refuses it ("'friday' and 'rerun' both name a pass") and one holding a quote breaks
 * the pasted line outright. So an id that is not a plain word is QUOTED, for the shell the operator
 * is holding; an ordinary one is printed bare, because a minted id is a timestamp and a remedy that
 * quotes what needs no quoting reads as a command with something odd about it.
 *
 * A NAMED pass widens what is cleared to whatever that pass's ledger holds, which is the form worth
 * printing beside a resume: the two are the same decision (continue this pass, or clear it) and an
 * operator choosing between them should not have to work out the second command's arguments.
 *
 * `all` is the widest form and no remedy prints it: it clears every frame the board lists, so it is
 * something an operator asks for rather than something a refusal suggests. It is rendered here
 * because the command's own output has to offer it back (the preview names what it previewed, and a
 * printed apply that dropped the flag would delete a different set than the one just read).
 */
export function resetInvocation(
  options: { runId?: string; all?: boolean; purgeRepos?: boolean; apply?: boolean } = {},
  flavour: ShellFlavour = shellFlavour(),
): string {
  return [
    RESET_INVOCATION,
    ...(options.runId ? [asOneWord(options.runId, flavour)] : []),
    ...(options.all ? ['--all'] : []),
    // Carried for the reason `--all` is: the command this prints must delete exactly the set just
    // previewed, and dropping a scope flag would silently narrow it between the two invocations.
    ...(options.purgeRepos ? ['--purge-repos'] : []),
    ...(options.apply ? ['--yes'] : []),
  ].join(' ')
}

/** A value that is already ONE shell word, or the dialect's quoting of one that is not. */
function asOneWord(value: string, flavour: ShellFlavour): string {
  return /^[\w.-]+$/.test(value) ? value : DIALECTS[flavour].literal(value)
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
