// How this suite renders a value INTO text an operator reads: a thrown value, an address, and a
// command they are expected to paste.
//
// Three one-liners, and each is here because it was written more than once. The suite's whole
// premise is that a refusal is worth more than a failure, which makes every one of these strings a
// deliverable rather than a log line, and the three mistakes below are the ones that quietly take
// the value back out of them.

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

/** The same job for PowerShell, whose single-quoted string DOUBLES a literal quote rather than escaping it. */
function powerShellQuoted(value: string): string {
  return `'${scrubbed(value).replaceAll("'", "''")}'`
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
export function resumeInvocation(runId: string, platform: string = process.platform): string {
  const run = 'pnpm --filter @cat-factory/acceptance run acceptance'
  // `;` and not `&&`: Windows PowerShell 5.1 has no pipeline chain operators, and a pasted `&&`
  // fails to PARSE, which is a worse answer than running the second half unconditionally.
  return platform === 'win32'
    ? `$env:ACCEPTANCE_RUN_ID = ${powerShellQuoted(runId)}; ${run}`
    : `ACCEPTANCE_RUN_ID=${shellQuoted(runId)} ${run}`
}

/**
 * Taking a per-person name prefix, so two operators share one board without colliding.
 *
 * Here for the same reason as {@link resumeInvocation}, and here rather than at its call site
 * because that keeps every shell dialect this suite prints in one module. The whole command differs
 * rather than only the assignment: the username is a SUBSTITUTION, so it cannot be quoted as a
 * value, and each shell spells both halves its own way (`export` versus `$env:`, `$(whoami)` versus
 * `$env:USERNAME`).
 */
export function perPersonPrefixInvocation(
  prefix: string,
  platform: string = process.platform,
): string {
  const name = 'ACCEPTANCE_NAME_PREFIX'
  return platform === 'win32'
    ? `$env:${name} = "${scrubbed(prefix)}-$env:USERNAME"`
    : `export ${name}="${scrubbed(prefix)}-$(whoami)"`
}
