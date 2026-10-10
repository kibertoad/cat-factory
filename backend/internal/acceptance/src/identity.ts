// WHO this suite is, as the kit's refusals render it, plus the three commands it prints.
//
// `@cat-factory/acceptance-kit` speaks to an operator in a dozen places (a probe failure re-reading
// the base URL, a wait that expired, the closing words of a failed pass), and every one of those
// sentences names something only a suite knows: the command that starts a pass, the variable that
// resumes one, the file the configuration was typed into. So this suite declares itself ONCE, here,
// and the kit renders against it.
//
// The invocations below are the suite's own, for the sites that print a command the kit has no
// concept of (clearing a board, taking a per-person name prefix). They go through the kit's dialect
// table rather than spelling a shell out, because `VAR=value command` is POSIX syntax that
// PowerShell reads as the COMMAND NAME, and a remedy which does not parse is worse than one with no
// command: it is offered as the thing to run.

import {
  perPersonAssignment,
  resumeCommand,
  type ShellFlavour,
  shellFlavour,
  shellWord,
  type SuiteIdentity,
} from '@cat-factory/acceptance-kit'

/** The command that runs a pass, in one place, so a printed remedy cannot drift from the README. */
const ACCEPTANCE_INVOCATION = 'pnpm --filter @cat-factory/acceptance run acceptance'

/** Same, for the command that clears a board back to "before any pass ran" (`src/reset.ts`). */
const RESET_INVOCATION = 'pnpm --filter @cat-factory/acceptance run reset'

/** Same, for the report that says where a pass got to (`src/status.ts`). */
const STATUS_INVOCATION = 'pnpm --filter @cat-factory/acceptance run status'

/**
 * This suite, for the kit.
 *
 * `docs` is the README section a refused preflight ends on, and the two command builders are what
 * `runPass` offers an operator whose pass stopped: the report, and the way to start over.
 */
export const ACCEPTANCE_IDENTITY: SuiteIdentity = {
  name: 'acceptance',
  runCommand: ACCEPTANCE_INVOCATION,
  runIdVariable: 'ACCEPTANCE_RUN_ID',
  baseUrlVariable: 'CAT_FACTORY_BASE_URL',
  workspaceVariable: 'ACCEPTANCE_WORKSPACE_ID',
  configFile: 'backend/internal/acceptance/.env',
  docs: 'backend/internal/acceptance/README.md#prerequisites',
  statusCommand: (runId) => `${STATUS_INVOCATION} ${runId}`,
  resetCommand: (runId) => `${RESET_INVOCATION} ${runId}`,
}

/**
 * The invocation that RESUMES a pass, in the shell the operator is actually holding.
 *
 * A named wrapper rather than the kit call at each site, so nothing has to remember to pass the
 * identity: a resume rendered against a default would name a variable this suite does not read.
 */
export function resumeInvocation(runId: string, flavour: ShellFlavour = shellFlavour()): string {
  return resumeCommand(ACCEPTANCE_IDENTITY, runId, flavour)
}

/**
 * The invocation that CLEARS a board, in the forms it is offered in.
 *
 * `apply: false` is the preview, which is what a remedy printed by a refusal offers first: this
 * deletes service frames, tasks and run history on a board somebody may share, so the reading an
 * operator does before the deletion is part of the design rather than caution (see `reset.ts`).
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
    ...(options.runId ? [shellWord(options.runId, flavour)] : []),
    ...(options.all ? ['--all'] : []),
    // Carried for the reason `--all` is: the command this prints must delete exactly the set just
    // previewed, and dropping a scope flag would silently narrow it between the two invocations.
    ...(options.purgeRepos ? ['--purge-repos'] : []),
    ...(options.apply ? ['--yes'] : []),
  ].join(' ')
}

/**
 * Taking a per-person name prefix, so two operators share one board without colliding.
 *
 * The one command whose VALUE is not a literal: the username is a substitution, which is why it
 * rides the kit's `perPersonAssignment` rather than an ordinary assignment. `ACCEPTANCE_NAME_PREFIX`
 * is read verbatim from the operator's own `.env`, so the literal half is escaped for the dialect it
 * lands in.
 */
export function perPersonPrefixInvocation(
  prefix: string,
  flavour: ShellFlavour = shellFlavour(),
): string {
  return perPersonAssignment('ACCEPTANCE_NAME_PREFIX', prefix, flavour)
}
