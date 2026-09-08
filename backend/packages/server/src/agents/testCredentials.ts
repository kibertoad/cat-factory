import type { Logger, TestCredentialBrief, TestSecretEntry } from '@cat-factory/kernel'
import { runBestEffort } from '@cat-factory/kernel'

// ---------------------------------------------------------------------------
// A service frame's sealed TEST CREDENTIALS, resolved once per dispatch into the two projections
// every flow that hands them to an agent needs: the `{ key, value }` pairs the harness turns into
// the agent process's environment, and the BRIEF the prompt states out loud.
//
// One resolution for the tester steps and the environment DRY RUN, because the dry run's whole
// claim is that it predicts what a tester will be handed. Resolved twice, the two disagreed about
// the case that matters most: the prober kept "the platform could not open its own store" apart
// from "this service has none configured", while the tester path folded a failed read into the
// unguarded dispatch wave, where it took the whole step down with an error about nothing the
// operator could act on.
//
// Best-effort in what it DOES and exact in what it SAYS. A store that will not open still runs the
// job WITHOUT credentials, because an agent that reports what was missing is worth more than a
// refused dispatch; `runBestEffort` returning `undefined` is an OUTAGE, and folding that into the
// same empty list as "none configured" is what makes an agent file the platform's failure as a
// board-configuration gap and send someone to re-enter secrets that are already there.
// ---------------------------------------------------------------------------

/** What one dispatch needs: the values for the container, and the state for the prompt. */
export interface ResolvedTestCredentials {
  /** The pairs the harness turns into environment variables of this one job's agent process. */
  env: { key: string; value: string }[]
  /** The same read, as the state the prompt states. Never carries a value. */
  brief: TestCredentialBrief
}

/**
 * Resolve a frame's test credentials for a dispatch that is entitled to them.
 *
 * `resolve` absent ⇒ this deployment has no sealed store wired at all, which is a DEPLOYMENT fact
 * (`unwired`) rather than an empty list: no service on the board can be handed credentials, so
 * telling a human to configure this one is the wrong instruction.
 */
export async function resolveTestCredentials(args: {
  resolve?: (workspaceId: string, blockId: string) => Promise<TestSecretEntry[]>
  workspaceId: string
  blockId: string
  logger: Logger
}): Promise<ResolvedTestCredentials> {
  if (!args.resolve) return { env: [], brief: { status: 'unwired' } }
  const entries = await runBestEffort(args.logger, 'resolve the frame test credentials', () =>
    args.resolve!(args.workspaceId, args.blockId),
  )
  if (!entries) return { env: [], brief: { status: 'unreadable' } }
  return {
    env: entries.map((entry) => ({ key: entry.key, value: entry.value })),
    brief: {
      status: 'resolved',
      refs: entries.map((entry) => ({ key: entry.key, description: entry.description })),
    },
  }
}
