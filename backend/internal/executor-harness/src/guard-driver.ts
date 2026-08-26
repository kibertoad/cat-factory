import { ProgressGuard, type ProgressGuardLimits } from './progress-guard.js'
import type { WorkspaceProbe } from './workspace-probe.js'
import { log as defaultLog, type Logger } from './logger.js'

// The bridge between the SYNCHRONOUS {@link ProgressGuard} and the ASYNCHRONOUS evidence one of
// its bounds needs. Both runners feed the guard from a sync stream handler (`pi.ts`'s JSONL line
// reader, `agent-runner.ts`'s tool_result pairing) and neither can await inside one, so the driver
// owns the probe's lifetime instead. Shared rather than copied per runner: a decision this one
// ("has the run stopped making progress") must come out the same way on both, which is why
// `ProgressGuard` itself was extracted in the first place.

/** The whole cause chain of a thrown value, one line, so a probe failure names what actually broke. */
function describeCause(error: unknown): string {
  const parts: string[] = []
  let current: unknown = error
  for (let depth = 0; depth < 8 && current !== undefined && current !== null; depth++) {
    parts.push(current instanceof Error ? current.message : String(current))
    current = current instanceof Error ? (current.cause as unknown) : undefined
  }
  return parts.filter((part) => part !== '').join(': ')
}

/** One run's guard plus the async settlement of the bound the stream alone cannot decide. */
export interface GuardDriver {
  /** Feed one tool-call signal (name + error flag) — the claude-code runner's shape. */
  observeSignal: (tool: { name: string; isError: boolean }) => void
  /** Feed one parsed Pi `--mode json` event; a non-tool-call event is a no-op. */
  observeEvent: (event: Record<string, unknown>) => void
  /** Whether the guard has decided to kill this run. */
  aborted: () => boolean
}

/**
 * Drive one run's {@link ProgressGuard}, resolving the one verdict the stream cannot settle.
 *
 * An `abort` verdict fires {@link onAbort} immediately: every streak bound (consecutive errors /
 * web calls / MCP calls / non-action calls) reads only the stream, so the stream is all the
 * evidence there is.
 *
 * A `needs-workspace-evidence` verdict — the no-edit bound — starts a probe of the working tree
 * and acts on its answer:
 *
 *  - MUTATED: the run has changed the repository, whichever tool it used. The bound is satisfied
 *    permanently, exactly as a recognised edit-tool call satisfies it, so no second probe is ever
 *    made and the run continues.
 *  - CLEAN: abort, with the evidence in the message.
 *  - THREW: inconclusive, which is neither a pass nor a fail. The bound is re-armed (it can trip
 *    again after another `maxToolCallsWithoutEdit` action calls) and the cause is warned. Failing
 *    open is deliberate: killing a productive run is the expensive error, and the streak bounds,
 *    the inactivity watchdog and the wall-clock cap all still hold the run.
 *
 * With no probe wired the bound falls back to its old tool-name-only judgement, so a caller with
 * no checkout to probe is no worse off than before.
 */
export function createGuardDriver(deps: {
  guard: ProgressGuard
  probe?: WorkspaceProbe | undefined
  /** Kill the run with this diagnostic. Called at most once. */
  onAbort: (reason: string) => void
  log?: Logger | undefined
}): GuardDriver {
  const logger = deps.log ?? defaultLog
  let aborted = false
  let probing = false

  const abort = (reason: string): void => {
    if (aborted) return
    aborted = true
    deps.onAbort(reason)
  }

  const settleFromWorkspace = (provisional: string): void => {
    const probe = deps.probe
    if (!probe) {
      // No checkout to probe: the tool-name reading is the only evidence there is, so act on it
      // rather than leaving the bound permanently unenforceable.
      abort(`${provisional} Aborting before it burns the whole run.`)
      return
    }
    probing = true
    void probe()
      .then((evidence) => {
        if (aborted) return
        if (evidence.mutated) {
          deps.guard.noteWorkspaceMutation()
          logger.info('progress-guard: working tree shows the run IS changing the repository', {
            headSha: evidence.headSha,
            headMoved: evidence.headMoved,
            dirtyPathCount: evidence.dirtyPathCount,
          })
          return
        }
        abort(
          `${provisional} The working tree agrees: at ${evidence.headSha} there is nothing ` +
            `uncommitted and HEAD has not moved since this pass began, so the repository is ` +
            `unchanged. Aborting before it burns the whole run.`,
        )
      })
      .catch((error: unknown) => {
        if (aborted) return
        deps.guard.rearmNoEditBound()
        logger.warn('progress-guard: workspace probe failed; treating it as inconclusive', {
          error: describeCause(error),
        })
      })
      .finally(() => {
        probing = false
      })
  }

  const act = (verdict: ReturnType<ProgressGuard['observeSignal']>): void => {
    if (aborted || !verdict) return
    if (verdict.kind === 'needs-workspace-evidence') {
      // A probe already in flight owns the current question. The guard itself suppresses a second
      // `needs-workspace-evidence` until one is answered; this is the belt to that braces.
      if (!probing) settleFromWorkspace(verdict.reason)
      return
    }
    abort(verdict.reason)
  }

  return {
    observeSignal: (tool) => {
      if (aborted) return
      act(deps.guard.observeSignal(tool))
    },
    observeEvent: (event) => {
      if (aborted) return
      act(deps.guard.observe(event))
    },
    aborted: () => aborted,
  }
}

/** What {@link createClaudeProgressGuard} needs off the run options, and nothing more. */
export interface ClaudeGuardOptions {
  guardLimits?: ProgressGuardLimits | undefined
  expectsEdits?: boolean | undefined
  workspaceProbe?: WorkspaceProbe | undefined
  log?: Logger | undefined
}

/**
 * No-progress guard on the claude-code CLI's own tool stream — the claude-code analogue of runPi's
 * guard, which cannot see the CLI's internal turns. The caller remembers each `tool_use` id's name
 * off the assistant turn (`rememberTool`) and hands the following user turn's content to
 * `feedGuard`, which pairs each `tool_result`'s `is_error` with that name.
 *
 * The first abort trips it: the diagnostic is recorded (readable via `reason()`, which the catch
 * surfaces over the generic abort message) and `guardAbort` fires, folded into streamCli's signal
 * so a tripped guard kills the CLI the same way the external watchdog does. Disabled when the
 * caller supplies no limits (only the external watchdog then bounds the run).
 *
 * Lives here rather than in `agent-runner.ts` because the async half of it — the workspace probe
 * behind the no-edit bound — is the same collaborator the Pi runner drives.
 */
export function createClaudeProgressGuard(opts: ClaudeGuardOptions): {
  rememberTool: (id: string, name: string) => void
  feedGuard: (content: unknown[]) => void
  guardAbort: AbortController
  reason: () => string | undefined
} {
  const toolNames = new Map<string, string>()
  const guardAbort = new AbortController()
  let guardReason: string | undefined

  const limits = opts.guardLimits
  const driver = limits
    ? createGuardDriver({
        guard: new ProgressGuard(limits, opts.expectsEdits ?? true),
        probe: opts.workspaceProbe,
        log: opts.log,
        onAbort: (reason) => {
          guardReason = reason
          guardAbort.abort()
        },
      })
    : undefined

  const feedGuard = (content: unknown[]): void => {
    if (!driver || driver.aborted()) return
    for (const block of content) {
      if (!isRecord(block) || block.type !== 'tool_result') continue
      const id = typeof block.tool_use_id === 'string' ? block.tool_use_id : undefined
      const name = id ? toolNames.get(id) : undefined
      if (id) toolNames.delete(id)
      if (!name) continue
      driver.observeSignal({ name, isError: block.is_error === true })
      if (driver.aborted()) return
    }
  }

  return {
    rememberTool: (id, name) => toolNames.set(id, name),
    feedGuard,
    guardAbort,
    reason: () => guardReason,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
