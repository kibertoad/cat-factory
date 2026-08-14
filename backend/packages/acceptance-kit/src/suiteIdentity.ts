// WHO is running, in the words its own operator would recognise.
//
// Everything in this kit that speaks to a person names something the kit cannot know: the command
// that starts a pass, the variable that resumes one, the file the operator keeps their configuration
// in. Left as constants those strings were right for exactly one suite, and a second suite built on
// the kit would print an operator instructions for somebody else's: "re-run with ACCEPTANCE_RUN_ID
// set" is not a fix in a repository where the variable is called something else, and a remedy whose
// command does not exist is worse than one with no command, because it is offered as the thing to
// run.
//
// So a suite declares itself ONCE, as data, and the kit's refusals render against it. That is also
// what keeps the remedies honest across a rename: one place to change, rather than a dozen literals
// spread over the modules that happen to print them.

import {
  assignFor,
  type ShellFlavour,
  shellFlavour,
  shellLiteral,
  shellWord,
} from './operatorText.js'

/**
 * What a suite built on this kit calls itself, and what it tells an operator to type.
 *
 * Every field is something a refusal quotes. None is decoration, and none has a default worth
 * guessing: a kit that invented `npm run acceptance` would be printing a command that does not
 * exist in most of the repositories that install it.
 */
export type SuiteIdentity = {
  /** The suite, as a person names it: a package name, or whatever its README calls it. */
  name: string
  /** The command that runs a pass, e.g. `pnpm --filter @acme/acceptance run acceptance`. */
  runCommand: string
  /**
   * The environment variable that PINS a pass's run id, which is how a re-run resumes rather than
   * starting a second one. Named here because the kit prints it in every refusal that offers a
   * resume, and reads it in `resolveRunId`.
   */
  runIdVariable: string
  /** The variable naming the backend origin, quoted whenever an answer puts the ADDRESS in question. */
  baseUrlVariable: string
  /**
   * Where the operator's variables live, as a path they can open (`backend/internal/acceptance/.env`).
   *
   * A probe failure sends a reader to re-read one value, and "check your environment" is not that
   * instruction: the point is that the value came from a FILE somebody typed rather than from a
   * discovery.
   */
  configFile: string
  /** A doc a refused preflight points at for the long version. Omitted where there is none. */
  docs?: string
  /** The command that reports where a pass got to, given its run id. Omitted where there is none. */
  statusCommand?: (runId: string) => string
  /** The command that clears a pass off the board, given its run id. Omitted where there is none. */
  resetCommand?: (runId: string) => string
}

/**
 * The invocation that RESUMES a pass, in the shell the operator is actually holding.
 *
 * `VAR=value command` is POSIX syntax and PowerShell has no inline environment prefix at all: it
 * reads the assignment as the COMMAND NAME and answers `CommandNotFoundException`. That is a remedy
 * which does not parse, offered as the thing to run, which is the failure `shellQuoted` exists
 * against one layer down. Windows is not an edge case for a suite like this: the pass drives a
 * deployment running on the operator's own machine.
 *
 * Deliberately NOT offered as a line in the configuration file. That is the platform-neutral way to
 * carry the id and a suite's own docs may well say so, but a value in the file becomes the DEFAULT
 * for every later pass, and the reason to print a command is that a resume is a ONE-OFF.
 */
export function resumeCommand(
  identity: SuiteIdentity,
  runId: string,
  flavour: ShellFlavour = shellFlavour(),
): string {
  // QUOTED whatever it holds, unlike `suiteCommand`'s positional: this is a variable assignment, and
  // a bare value there is one shell-special character away from assigning something else entirely.
  return assignFor(
    identity.runIdVariable,
    shellLiteral(runId, flavour),
    identity.runCommand,
    flavour,
  )
}

/**
 * One of the identity's OWN commands, rendered around a run id.
 *
 * The id is a FILE NAME and a hand-named pass is supported ('friday-rerun'), so one holding a space
 * renders a command whose own parser refuses it and one holding a quote breaks the pasted line
 * outright. An ordinary id is printed bare, because a minted one is a timestamp and a remedy that
 * quotes what needs no quoting reads as a command with something odd about it.
 */
export function suiteCommand(
  command: (runId: string) => string,
  runId: string,
  flavour: ShellFlavour = shellFlavour(),
): string {
  return command(shellWord(runId, flavour))
}

/**
 * The tail a wait and a probe refusal end on: what is still standing, and how to pick it back up.
 *
 * Shared because it is true wherever a pass stops and a reader needs it in either place: a suite
 * like this deliberately cleans nothing up, and an operator who assumes otherwise starts a second
 * pass that the first one's leftovers then refuse.
 */
export function leftInPlaceNote(identity: SuiteIdentity): string {
  return (
    `Nothing was cleaned up: whatever this pass created (runs, pull requests, provisioned ` +
    `environments) is still there to inspect. Re-run with ${identity.runIdVariable} set to this ` +
    `pass's run id to resume once the cause is fixed.`
  )
}
