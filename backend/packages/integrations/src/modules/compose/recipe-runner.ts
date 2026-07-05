import type { RecipeHealthGate, RecipeStep } from '@cat-factory/kernel'
import {
  type ComposeRuntime,
  classifyComposePs,
  composeExecArgs,
  matchesHttpExpectation,
  recipeStepIntervalMs,
  recipeStepTimeoutMs,
  tailOutput,
  waitFileExecArgs,
} from './compose-environment.logic.js'

// Shared execution of a STACK RECIPE's ordered setup steps + terminal health gate against an
// injected `ComposeRuntime`. Extracted so BOTH the per-PR `ComposeEnvironmentProvider` and the
// long-lived `SharedStackService` drive the identical step/gate semantics (compose-exec / copy-file
// / wait-http / wait-file / host-command; compose-healthy / http / compose-exec gates) rather than
// each re-implementing the poll loop. Every function is normalized to never throw — a step's error
// is a `StepResult`, so the caller decides whether to tear the stack down. Local-facade-only
// (needs a host daemon), so the poll sleep is a plain `setTimeout`.

/** A normalized recipe-step verdict. */
export interface StepResult {
  ok: boolean
  detail?: string
  error?: string
}

/** One poll attempt's outcome: `done` (satisfied), `fatal` (stop early), else keep polling. */
interface ProbeResult {
  done: boolean
  fatal?: boolean
  error?: string
}

/** The shared context a recipe step / gate runs against: the compose `-p …-f …` scope + env + project. */
export interface RecipeRunContext {
  runtime: ComposeRuntime
  /** The `['-p', project, '--project-directory', dir, '-f', …]` prefix every compose call shares. */
  scope: string[]
  env: Record<string, string>
  /** The per-project checkout key (for `copy-file` / checkout `wait-file` / `host-command`). */
  project: string
}

/** Run one recipe setup/teardown step, returning a normalized verdict (never throws). */
export async function runRecipeStep(step: RecipeStep, ctx: RecipeRunContext): Promise<StepResult> {
  const { runtime, scope, env, project } = ctx
  const timeoutMs = recipeStepTimeoutMs(step)
  try {
    switch (step.kind) {
      case 'compose-exec': {
        const res = await runtime.compose(composeExecArgs(scope, step), {
          env,
          timeoutMs,
          ...(step.stdinFile ? { stdin: { project, checkoutFile: step.stdinFile } } : {}),
        })
        return res.code === 0
          ? { ok: true }
          : { ok: false, error: tailOutput(res.stderr || res.stdout) || `exit ${res.code}` }
      }
      case 'copy-file': {
        if (!runtime.copyCheckoutFile)
          return { ok: false, error: 'runtime cannot copy checkout files' }
        await runtime.copyCheckoutFile(project, step.from, step.to)
        return { ok: true }
      }
      case 'wait-http':
        return pollUntil(timeoutMs, recipeStepIntervalMs(step), () => probeHttp(step.url, step))
      case 'wait-file':
        return pollUntil(timeoutMs, recipeStepIntervalMs(step), () => probeFile(step, ctx))
      case 'host-command': {
        if (!runtime.hostCommand) return { ok: false, error: 'runtime cannot run host commands' }
        const res = await runtime.hostCommand(project, step.command, {
          ...(step.workdir ? { workdir: step.workdir } : {}),
          env,
          timeoutMs,
        })
        return res.code === 0
          ? { ok: true }
          : { ok: false, error: tailOutput(res.stderr || res.stdout) || `exit ${res.code}` }
      }
      default:
        // A structural guard elsewhere validates the recipe, so a stale/hand-edited config can
        // carry an unknown step kind. Return a clean verdict rather than falling off the switch.
        return {
          ok: false,
          error: `unsupported recipe step kind '${(step as { kind?: string }).kind ?? 'unknown'}'`,
        }
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** Run the terminal health gate until it passes or its budget elapses (never throws). */
export async function runHealthGate(
  gate: RecipeHealthGate,
  ctx: { runtime: ComposeRuntime; scope: string[]; env: Record<string, string> },
  budget: { timeoutMs: number; intervalMs: number; shortTimeoutMs: number },
): Promise<StepResult> {
  const { runtime, scope, env } = ctx
  const { timeoutMs, intervalMs, shortTimeoutMs } = budget
  if (gate.kind === 'http') {
    return pollUntil(timeoutMs, intervalMs, () => probeHttp(gate.url, gate, shortTimeoutMs))
  }
  if (gate.kind === 'compose-exec') {
    return pollUntil(timeoutMs, intervalMs, async () => {
      const res = await runtime.compose(
        composeExecArgs(scope, { service: gate.service, command: gate.command }),
        { env, timeoutMs: shortTimeoutMs },
      )
      return {
        done: res.code === 0,
        error: tailOutput(res.stderr || res.stdout) || `exit ${res.code}`,
      }
    })
  }
  // compose-healthy: poll `ps` until the stack is ready / a service crashed.
  return pollUntil(timeoutMs, intervalMs, async () => {
    const ps = await runtime.compose([...scope, 'ps', '-a', '--format', 'json'], {
      env,
      timeoutMs: shortTimeoutMs,
    })
    const status = ps.code === 0 ? classifyComposePs(ps.stdout) : 'provisioning'
    if (status === 'ready') return { done: true }
    if (status === 'failed')
      return { done: false, fatal: true, error: 'a service is unhealthy or crashed' }
    return { done: false, error: 'stack not healthy yet' }
  })
}

/** Probe a URL once for a `wait-http` step / `http` gate; a network error is a non-fatal retry. */
async function probeHttp(
  url: string,
  opts: { expectStatus?: number; expectBodyContains?: string },
  timeoutMs = 60_000,
): Promise<ProbeResult> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    // Read the body only when a substring is required; otherwise release it so the poll doesn't
    // leave an unconsumed body pinning the connection on every re-probe.
    let body = ''
    if (opts.expectBodyContains) body = await res.text()
    else await res.body?.cancel()
    return matchesHttpExpectation(res.status, body, opts)
      ? { done: true }
      : { done: false, error: `HTTP ${res.status}` }
  } catch (err) {
    return { done: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** Probe a `wait-file` step once — in a container (`test -f`) or the checkout. */
async function probeFile(
  step: Extract<RecipeStep, { kind: 'wait-file' }>,
  ctx: RecipeRunContext,
  shortTimeoutMs = 60_000,
): Promise<ProbeResult> {
  const { runtime, scope, env, project } = ctx
  if (step.service) {
    const res = await runtime.compose(waitFileExecArgs(scope, step.service, step.path), {
      env,
      timeoutMs: shortTimeoutMs,
    })
    return res.code === 0 ? { done: true } : { done: false, error: `not present yet` }
  }
  const exists = (await runtime.checkoutFileExists?.(project, step.path)) ?? false
  return exists ? { done: true } : { done: false, error: `not present yet` }
}

/**
 * Poll `attempt` until it reports `done` (success) or `fatal` (a definitive failure — stop early),
 * or the budget elapses (timeout failure). Attempts at least once; sleeps `intervalMs` between tries.
 */
async function pollUntil(
  timeoutMs: number,
  intervalMs: number,
  attempt: () => Promise<ProbeResult>,
): Promise<StepResult> {
  const deadline = Date.now() + timeoutMs
  let lastError = 'timed out'
  for (;;) {
    const res = await attempt()
    if (res.done) return { ok: true }
    if (res.fatal) return { ok: false, error: res.error ?? 'failed' }
    lastError = res.error ?? lastError
    if (Date.now() + intervalMs >= deadline) {
      return { ok: false, error: `timed out after ${timeoutMs}ms (${lastError})` }
    }
    await sleep(intervalMs)
  }
}

/** Sleep `ms` between poll attempts (host-side; recipe execution is local-facade only). */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
