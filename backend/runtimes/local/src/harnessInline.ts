import { spawn } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { delimiter, join } from 'node:path'
import {
  CliInlineLanguageModel,
  type InlineCliRequest,
  type InlineCliResult,
  type InlineCliRunner,
} from '@cat-factory/agents'
import {
  describeProcessExit,
  type HarnessKind,
  isAmbientNativeVendor,
  isIndividualVendor,
  type ModelProvider,
  type ModelProviderResolver,
  type ModelRef,
  type ModelScope,
  nativeVendorForRef,
  redactSecrets,
  SUBSCRIPTION_VENDORS,
  type SubscriptionVendor,
  subscriptionVendorForRef,
} from '@cat-factory/kernel'
import type { InlineContainerRequest } from './LocalContainerRunnerTransport.js'
import type { InlineJobResult } from './harnessHttp.js'
import { sanitizedChildEnv } from './childEnv.js'

// Local-mode INLINE harness execution: run the developer's ambient `claude` / `codex` CLI as a
// host subprocess to serve the inline LLM steps (requirements reviewer, brainstorm,
// task-estimator, inline document kinds) on a subscription model. Gated by `LOCAL_NATIVE_INLINE`
// (default ON), DECOUPLED from the container-native `LOCAL_NATIVE_AGENTS` opt-in — an inline step
// is a one-shot text call (no repo checkout, no tools), so running it on the local CLI is benign
// and on by default. Only NATIVE ambient vendors qualify (`claude` / `codex`, no injected
// credential); a non-native claude-code vendor (GLM/Kimi/DeepSeek) keeps degrading to a provider
// model, exactly as `nativeVendorForRef` / `isAmbientNativeVendor` gate the container path — so
// the guard's `inlineHarnessRef` predicate and this provider agree on what can run inline.

/**
 * Runs a CLI once: feed the prompt over stdin, collect stdout, reject on non-zero exit, abort,
 * or timeout. The injectable seam ({@link CliExec}) so the vendor runners below are unit-testable
 * with a fake process (mirroring the injectable exec every other local subprocess transport
 * takes) — the default is the real {@link spawnCliExec}.
 */
export type CliExec = (
  command: string,
  args: string[],
  stdin: string,
  opts?: { signal?: AbortSignal; timeoutMs?: number },
) => Promise<string>

// A hung ambient CLI (network stall, an approval prompt not covered by the bypass flags, a
// subprocess blocked on stdin) emits neither `close` nor `error`, so without a watchdog the
// inline step would park forever — the callers pass no AbortSignal. Kill it after this budget.
const DEFAULT_CLI_TIMEOUT_MS = 300_000
// A CLI that ignores SIGTERM is escalated to SIGKILL after this grace period.
const KILL_GRACE_MS = 2_000
/** How much of the CLI's output a failure message carries. Tail-biased: the error is at the end. */
const EXIT_OUTPUT_TAIL_CHARS = 700

/**
 * The message a badly-ended inline CLI fails with.
 *
 * `claude -p` reports an API refusal (quota, rate limit, auth) as JSON on STDOUT and leaves stderr
 * EMPTY, so a stderr-only message carries nothing but the exit code, and the reason the caller's
 * in-band `is_error` check would have surfaced is dropped on the floor. Carry whichever stream
 * actually spoke, and say so when neither did rather than trailing off after a colon.
 *
 * Both streams are command output, so both are scrubbed at this emit site — the sibling in the
 * container harness (`streamCli`) redacts its stderr tail for the same reason, and stdout here is
 * strictly more exposed since it holds the model's own text. Scrub BEFORE the tail slice, so a
 * partially-cut credential cannot survive by being unrecognisable to the pattern rules.
 */
function cliExitMessage(
  command: string,
  code: number | null,
  killSignal: NodeJS.Signals | null,
  stderr: string,
  stdout: string,
): string {
  const spoke = stderr.trim() || stdout.trim()
  const tail = (redactSecrets(spoke) ?? '').slice(-EXIT_OUTPUT_TAIL_CHARS) || '(no output)'
  return `${command} ${describeProcessExit(code, killSignal)}: ${tail}`
}

/**
 * How long a run must have been quiet before its silence is worth reporting. Mirrors the container
 * harness's `SILENCE_BREADCRUMB_MS` and its reasoning: without the threshold every fast failure (a
 * missing binary, an auth rejection) would gain a true-but-useless "said nothing" clause for a
 * phase where the CLI was never going to have spoken yet.
 */
const SILENCE_BREADCRUMB_MS = 30_000

/**
 * How quiet the run had gone before it died, or `''` when silence isn't part of the story. Exit
 * status alone can't separate a CLI that stalled from one that died on its first line — and for the
 * watchdog kill silence IS the whole diagnosis, because the message otherwise reports only that the
 * budget elapsed.
 *
 * The container harness's twin says "no activity" because its channel also carries synthetic
 * keep-alive beats. Here the channel is literally the child's stdout/stderr, so this claims exactly
 * that much and no more: the CLI itself was silent.
 *
 * Exported for its own test (like {@link spawnCliExec}): reaching the threshold through a real
 * subprocess would mean a 30s test.
 */
export function silenceClause(
  startedAt: number,
  lastOutputAt: number | undefined,
  now: number,
): string {
  const silentMs = now - (lastOutputAt ?? startedAt)
  if (silentMs < SILENCE_BREADCRUMB_MS) return ''
  const secs = Math.round(silentMs / 1000)
  return lastOutputAt === undefined ? `no output at all in ${secs}s` : `silent for ${secs}s`
}

/**
 * A CLI run that ended badly, carrying the evidence only the SPAWN SITE holds: everything the child
 * had written before it died, and (already folded into `message`) how quiet it had gone.
 *
 * The partial stdout rides along because the spawn site cannot interpret it — only the vendor runner
 * knows its own output format. {@link makeClaudeRunner} catches this to append what Claude Code's
 * event stream says the run had already consumed; the previous `reject(new Error(...))` discarded
 * that buffer outright, which is why a killed run could burn millions of tokens and report nothing.
 */
export class CliExecFailure extends Error {
  constructor(
    message: string,
    readonly reason: 'timeout' | 'aborted' | 'exit',
    /** Everything the CLI wrote to stdout before it died — its partial event stream. */
    readonly stdout: string,
  ) {
    super(message)
    this.name = 'CliExecFailure'
  }
}

/** The default {@link CliExec}: a real `node:child_process` spawn with a timeout watchdog.
 * Exported for its own tests (the sanitized-env contract); callers use the runner builders. */
export const spawnCliExec: CliExec = (command, args, stdin, opts = {}) =>
  new Promise((resolve, reject) => {
    const { signal, timeoutMs = DEFAULT_CLI_TIMEOUT_MS } = opts
    if (signal?.aborted) {
      // Deliberately a plain Error, not a {@link CliExecFailure}: nothing ran, so there is no
      // stream to account for and no silence to measure. The message already says as much, and the
      // vendor runner passes a non-`CliExecFailure` through untouched rather than appending a
      // redundant "no model call completed".
      reject(new Error(`${command} aborted before start`))
      return
    }
    // The inline CLI runs IN the orchestrator process's environment — sanitize it down to
    // the allow-list so the agent never inherits the backend's secrets (DATABASE_URL,
    // ENCRYPTION_KEY, GITHUB_PAT, …), mirroring the host-process harness transport.
    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: sanitizedChildEnv(process.env),
    })
    child.stdin.on('error', () => {})
    child.stdin.end(stdin)
    let stdout = ''
    let stderr = ''
    // When the child last spoke on EITHER stream, so a failure can say how long it had been quiet.
    // `undefined` until the first byte — the honest distinction between a run that went quiet and
    // one that never produced anything at all.
    const startedAt = Date.now()
    let lastOutputAt: number | undefined
    let killedReason: 'aborted' | 'timeout' | undefined
    let killTimer: ReturnType<typeof setTimeout> | undefined
    // Terminate the child (SIGTERM), escalating to SIGKILL if it doesn't exit promptly.
    const terminate = (reason: 'aborted' | 'timeout'): void => {
      killedReason = reason
      child.kill('SIGTERM')
      killTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS)
      killTimer.unref?.()
    }
    const onAbort = (): void => terminate('aborted')
    signal?.addEventListener('abort', onAbort, { once: true })
    const watchdog = setTimeout(() => terminate('timeout'), timeoutMs)
    watchdog.unref?.()
    const cleanup = (): void => {
      signal?.removeEventListener('abort', onAbort)
      clearTimeout(watchdog)
      if (killTimer) clearTimeout(killTimer)
    }
    child.stdout.on('data', (chunk: Buffer) => {
      lastOutputAt = Date.now()
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      lastOutputAt = Date.now()
      stderr += chunk.toString()
      if (stderr.length > 8_000) stderr = stderr.slice(-8_000)
    })
    child.on('error', (err) => {
      cleanup()
      reject(err)
    })
    // `killSignal`, not `signal`: the outer `signal` in scope here is the caller's AbortSignal,
    // and shadowing it with the exit signal would silently hand the wrong value to any later
    // line in this handler that reaches for it.
    child.on('close', (code, killSignal) => {
      cleanup()
      // Every bad end goes out as a {@link CliExecFailure} carrying the partial stdout and the
      // silence clause. The watchdog and abort paths used to reject with the bare fact that the
      // budget elapsed — no output, no timing, nothing about what the run had already done — which
      // made a run that burned through a poll budget indistinguishable from one that never reached
      // the model. The vendor runner adds what the stream says it consumed.
      const failed = (reason: 'timeout' | 'aborted' | 'exit', base: string): void => {
        const silence = silenceClause(startedAt, lastOutputAt, Date.now())
        reject(new CliExecFailure(silence ? `${base}; ${silence}` : base, reason, stdout))
      }
      if (killedReason === 'timeout') {
        failed('timeout', `${command} timed out after ${timeoutMs}ms`)
        return
      }
      if (killedReason === 'aborted') {
        failed('aborted', `${command} aborted`)
        return
      }
      if (code !== 0) {
        // BOTH streams, not just stderr — see {@link cliExitMessage} for why, and for what is
        // scrubbed out of them on the way.
        failed('exit', cliExitMessage(command, code, killSignal, stderr, stdout))
        return
      }
      resolve(stdout)
    })
  })

/**
 * Read the CLI's Anthropic usage into the three ORTHOGONAL input classes, mirroring the
 * harness's `claudeCallUsage`. `input_tokens` is already exclusive of both caches, so nothing
 * is subtracted here — and the classes are deliberately NOT summed into one figure: this path
 * is the one place a local deployment's inline steps are observable at all, and a lumped count
 * cannot say whether a run is riding a warm cache (~0.1× base input) or re-writing it every
 * turn (1.25–2×).
 */
function claudeUsage(raw: unknown): InlineCliResult['usage'] {
  if (typeof raw !== 'object' || raw === null) return undefined
  const r = raw as Record<string, unknown>
  const num = (v: unknown): number => (typeof v === 'number' ? v : 0)
  const input = num(r.input_tokens)
  const cacheRead = num(r.cache_read_input_tokens)
  const cacheWrite = num(r.cache_creation_input_tokens)
  const output = num(r.output_tokens)
  if (input === 0 && cacheRead === 0 && cacheWrite === 0 && output === 0) return undefined
  return {
    inputTokens: input,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    outputTokens: output,
  }
}

// Claude Code reports failures IN-BAND (process exit 0) via `is_error` / an `error_*` subtype,
// with the error text in `result`. Left unchecked, that error string would be handed back as a
// "successful" reviewer answer and parsed as a real (garbage) review; surface it as a throw so
// the run fails instead. (These one-shot CLIs expose no token-length stop reason, so a genuine
// output-cap truncation still reads as `stop` — the reviewer's `finishReason === 'length'`
// guard only fires for HTTP providers. `error_max_turns` is the closest limit signal they give.)
const CLAUDE_ERROR_SUBTYPES = new Set(['error_max_turns', 'error_during_execution'])

/**
 * Fold Claude Code's `stream-json` output into the run's terminal `result` event plus the
 * cumulative telemetry of the calls that got as far as reporting usage.
 *
 * Envelopes are keyed by `message.id` BEFORE summing, because the stream emits one envelope per
 * CONTENT BLOCK of a response, each repeating that ONE call's `usage` — a turn that answers with
 * text and then fires five tool calls arrives as six envelopes. Summing per envelope therefore
 * multiplies the burn: on the run that motivated this change, 117 envelopes carried 31 real calls
 * and the naive sum inflated 1.47M tokens to 5.53M (3.8x). The container harness hit exactly this
 * trap and fixed it the same way — see `claude-call-aggregator.ts` and
 * docs/initiatives/token-burn-instrumentation.md.
 */
function claudeStreamTelemetry(stdout: string): {
  calls: number
  usage: InlineCliResult['usage']
  result: Record<string, unknown> | undefined
} {
  const usageByCall = new Map<string, unknown>()
  let result: Record<string, unknown> | undefined
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let event: unknown
    try {
      event = JSON.parse(trimmed)
    } catch {
      continue // a wrapper/progress line that isn't an event
    }
    if (typeof event !== 'object' || event === null) continue
    const e = event as Record<string, unknown>
    // The terminal event, the same object `--output-format json` used to emit on its own. LAST one
    // wins: it is the run's authoritative account of itself.
    if (e.type === 'result') {
      result = e
      continue
    }
    const message = e.message
    if (typeof message !== 'object' || message === null) continue
    const m = message as Record<string, unknown>
    if (m.usage === undefined) continue
    // Keyed by call id, so a response's repeated per-block usage is counted ONCE. An envelope
    // without an id can't be folded, so it stands alone rather than colliding with its siblings.
    usageByCall.set(typeof m.id === 'string' ? m.id : `anon:${usageByCall.size}`, m.usage)
  }
  let inputTokens = 0
  let cacheReadTokens = 0
  let cacheWriteTokens = 0
  let outputTokens = 0
  for (const raw of usageByCall.values()) {
    const one = claudeUsage(raw)
    if (!one) continue
    inputTokens += one.inputTokens ?? 0
    cacheReadTokens += one.cacheReadTokens ?? 0
    cacheWriteTokens += one.cacheWriteTokens ?? 0
    outputTokens += one.outputTokens ?? 0
  }
  return {
    calls: usageByCall.size,
    usage:
      usageByCall.size === 0
        ? undefined
        : { inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens },
    result,
  }
}

/** Compact token counts: a breadcrumb is read by a human, not summed by anything. */
function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(2)}M`
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`
  return String(count)
}

/**
 * What the run consumed before it died, in the two terms that change the diagnosis: whether the
 * model was reached at all, and whether a warm cache carried the input (`claudeUsage` keeps the
 * input classes apart for precisely this reason — a cache-heavy run is ~0.1x the base rate).
 */
function claudeBurnClause(calls: number, usage: InlineCliResult['usage']): string {
  if (calls === 0 || !usage) return 'no model call completed'
  const total =
    (usage.inputTokens ?? 0) +
    (usage.cacheReadTokens ?? 0) +
    (usage.cacheWriteTokens ?? 0) +
    (usage.outputTokens ?? 0)
  return (
    `burned ${formatTokens(total)} tokens ` +
    `(${formatTokens(usage.cacheReadTokens ?? 0)} cache-read) ` +
    `across ${calls} model call${calls === 1 ? '' : 's'}`
  )
}

/**
 * A runner for the ambient `claude` CLI. The role rides `--append-system-prompt`; the prompt goes
 * over stdin. Bypass permissions so the headless run never blocks on an approval prompt (an inline
 * text task uses no tools anyway).
 *
 * Streams `--output-format stream-json --verbose` rather than taking the single-object `json`: that
 * lone result object exists ONLY if the CLI reaches the end, so a run the watchdog killed reported
 * nothing whatsoever about what it had already spent — and nothing else recorded it either, because
 * a failed step writes no `token_usage` row on either transport. The terminal event carries the same
 * fields the single object did, so the success path is unchanged; the difference is that a killed run
 * now still has a stream to account for itself with. Stream volume is bounded by the watchdog.
 */
function makeClaudeRunner(exec: CliExec): InlineCliRunner {
  return async (req: InlineCliRequest): Promise<InlineCliResult> => {
    const args = [
      '-p',
      '--output-format',
      'stream-json',
      // Required alongside `stream-json` in print mode, exactly as the container harness runs it.
      '--verbose',
      '--permission-mode',
      'bypassPermissions',
    ]
    if (req.system.trim()) args.push('--append-system-prompt', req.system)
    args.push('--model', req.model)
    let stdout: string
    try {
      stdout = await exec('claude', args, req.prompt, req.signal ? { signal: req.signal } : {})
    } catch (error) {
      if (error instanceof CliExecFailure) throw claudeFailureWithBurn(error)
      throw error
    }
    const { result } = claudeStreamTelemetry(stdout)
    if (!result) {
      // No terminal event (an older CLI, or a wrapper that swallowed the stream) — fall back to the
      // raw text, as the single-object path did when its JSON wouldn't parse.
      return { text: stdout.trim(), finishReason: 'stop' }
    }
    const subtype = typeof result.subtype === 'string' ? result.subtype : undefined
    if (result.is_error === true || (subtype && CLAUDE_ERROR_SUBTYPES.has(subtype))) {
      const detail = typeof result.result === 'string' ? result.result : (subtype ?? 'error')
      throw new Error(
        `claude reported an error (${subtype ?? 'is_error'}): ` +
          detail.slice(0, EXIT_OUTPUT_TAIL_CHARS),
      )
    }
    const text = typeof result.result === 'string' ? result.result : ''
    // The terminal event's own cumulative figure, not the folded per-call sum: on a run that
    // finished, the CLI's account of itself is authoritative.
    return { text, finishReason: 'stop', usage: claudeUsage(result.usage) }
  }
}

/**
 * Re-throw a badly-ended `claude` run with what its PARTIAL stream says it had already consumed.
 * The cause chain is kept so a caller that wants the reason (`timeout` / `aborted` / `exit`) still
 * has it.
 */
function claudeFailureWithBurn(failure: CliExecFailure): Error {
  const { calls, usage } = claudeStreamTelemetry(failure.stdout)
  return new Error(`${failure.message}; ${claudeBurnClause(calls, usage)}`, { cause: failure })
}

/**
 * A runner for the ambient `codex` CLI. Codex has no system-prompt flag, so the composed role is
 * prepended to the prompt (as the harness does), and `codex exec` prints the final assistant
 * message to stdout. Sandbox/approvals are bypassed (the developer's own machine).
 */
function makeCodexRunner(exec: CliExec): InlineCliRunner {
  return async (req: InlineCliRequest): Promise<InlineCliResult> => {
    const prompt = req.system.trim() ? `${req.system}\n\n---\n\n${req.prompt}` : req.prompt
    const args = [
      'exec',
      '--skip-git-repo-check',
      '--dangerously-bypass-approvals-and-sandbox',
      '--model',
      req.model,
      '-',
    ]
    const stdout = await exec('codex', args, prompt, req.signal ? { signal: req.signal } : {})
    return { text: stdout.trim(), finishReason: 'stop' }
  }
}

/** Build the inline runner for a native ambient vendor over an injectable CLI exec seam. */
export function runnerForVendor(
  vendor: SubscriptionVendor,
  exec: CliExec = spawnCliExec,
): InlineCliRunner {
  return vendor === 'codex' ? makeCodexRunner(exec) : makeClaudeRunner(exec)
}

/**
 * Whether a ref can be served as an inline subscription call given the deployment's enabled
 * inline harnesses (`LOCAL_NATIVE_INLINE`) — the single predicate shared by the config
 * (`inlineHarnessRef`, so the start guard treats such a model as inline-satisfiable) and the
 * provider wrapper below (so the two never disagree). Broader than C1's host-CLI-only predicate:
 * with the prewarmed-container backend, ANY subscription vendor whose HARNESS is enabled is
 * inline-servable (host CLI for a native ambient vendor when its binary is present, else the
 * container on a leased credential) — so `glm`/`kimi`/`deepseek` (non-native claude-code
 * vendors) qualify too, not just `claude`/`codex`. Empty allow-list (`LOCAL_NATIVE_INLINE=off`)
 * ⇒ never inline (the start guard then refuses a subscription-only inline step, as before).
 */
export function makeInlineHarnessPredicate(
  inlineHarnesses: readonly HarnessKind[] | undefined,
): (ref: ModelRef) => boolean {
  return (ref) => {
    if (!inlineHarnesses || inlineHarnesses.length === 0) return false
    const vendor = subscriptionVendorForRef(ref)
    return !!vendor && inlineHarnesses.includes(SUBSCRIPTION_VENDORS[vendor].harness)
  }
}

/** Whether a binary is resolvable on the process PATH (sync, no spawn). Windows-aware. */
function binaryOnPath(command: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const pathValue = env.PATH ?? env.Path ?? ''
  if (!pathValue) return false
  const exts = process.platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : ['']
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue
    for (const ext of exts) {
      try {
        accessSync(join(dir, command + ext.toLowerCase()), constants.X_OK)
        return true
      } catch {
        // not here / not executable — keep scanning
      }
    }
  }
  return false
}

/**
 * The set of native ambient vendors (`claude` / `codex`) whose HOST CLI is installed, detected
 * ONCE at wiring time (a PATH scan, no spawn). The provider prefers the host CLI for these
 * (unmetered, the developer's own ambient login); every other case runs in the container on a
 * leased credential. Only the two native vendors are ever host-CLI-served — a non-native vendor
 * (GLM/Kimi/DeepSeek) has no ambient login, so it always goes to the container.
 */
export function detectHostInlineClis(
  env: NodeJS.ProcessEnv = process.env,
): Set<SubscriptionVendor> {
  const present = new Set<SubscriptionVendor>()
  if (binaryOnPath('claude', env)) present.add('claude')
  if (binaryOnPath('codex', env)) present.add('codex')
  return present
}

/** Runs a one-shot inline job inside a leased warm container (the transport's `runInline`). */
type RunInlineInContainer = (req: InlineContainerRequest) => Promise<InlineJobResult>

/** The subscription-credential lease seams the container inline path needs (from buildNodeContainer). */
interface InlineLeaseDeps {
  /** Lease the run-initiator's activated personal credential (individual vendors). */
  leasePersonalSubscriptionToken?: (
    executionId: string,
    userId: string,
    vendor: SubscriptionVendor,
  ) => Promise<{ secret: string }>
  /** Lease a pooled workspace subscription token (poolable vendors). */
  leaseSubscriptionToken?: (
    workspaceId: string,
    vendor: SubscriptionVendor,
  ) => Promise<{ secret: string }>
}

/** Everything the inline resolver wrapper needs to serve subscription refs (host CLI + container). */
export interface InlineHarnessResolverDeps extends InlineLeaseDeps {
  /** The enabled inline harnesses (`LOCAL_NATIVE_INLINE`); empty ⇒ inline off. */
  inlineHarnesses: readonly HarnessKind[]
  /** Native ambient vendors whose host CLI is present (prefer the host CLI for these). */
  hostCliVendors: ReadonlySet<SubscriptionVendor>
  /** Run a one-shot inline job in a warm container. Absent ⇒ container backend unavailable. */
  runInline?: RunInlineInContainer
  /** Injectable host-CLI exec seam (defaults to a real spawn); tests pass a fake. */
  exec?: CliExec
}

/**
 * Build the container-backed {@link InlineCliRunner} for a subscription `vendor`/`ref` and run
 * scope: lease the credential (personal for an individual vendor, pooled otherwise), inject it +
 * the vendor base URL into the `inline` job, and run it in a warm container via `runInline`. The
 * credential is turned into env INSIDE the harness (never here), mirroring the coding path.
 */
function makeContainerRunner(
  vendor: SubscriptionVendor,
  ref: ModelRef,
  scope: ModelScope,
  deps: InlineHarnessResolverDeps,
): InlineCliRunner {
  return async (req: InlineCliRequest): Promise<InlineCliResult> => {
    if (!deps.runInline) {
      throw new Error(
        `Inline ${vendor} model needs the local container backend, which is not available.`,
      )
    }
    let secret: string
    if (isIndividualVendor(vendor)) {
      if (!deps.leasePersonalSubscriptionToken) {
        throw new Error(
          `Personal ${vendor} subscriptions are not configured on this deployment (no ENCRYPTION_KEY).`,
        )
      }
      if (!scope.executionId || !scope.userId) {
        // An individual credential is owned by a specific user and activated per run; without
        // the run/user we can't lease it. (Pooled vendors need only the workspace, below.)
        throw new Error(
          `Running an inline ${vendor} model requires a signed-in user and an active run.`,
        )
      }
      const leased = await deps.leasePersonalSubscriptionToken(
        scope.executionId,
        scope.userId,
        vendor,
      )
      secret = leased.secret
    } else {
      if (!deps.leaseSubscriptionToken) {
        throw new Error(`The ${vendor} subscription pool is not configured on this deployment.`)
      }
      const leased = await deps.leaseSubscriptionToken(scope.workspaceId, vendor)
      secret = leased.secret
    }
    const baseUrl = SUBSCRIPTION_VENDORS[vendor].baseUrl
    const result = await deps.runInline({
      harness: SUBSCRIPTION_VENDORS[vendor].harness,
      model: ref.model,
      system: req.system,
      prompt: req.prompt,
      ...(req.maxOutputTokens != null ? { maxOutputTokens: req.maxOutputTokens } : {}),
      subscriptionToken: secret,
      ...(baseUrl ? { subscriptionBaseUrl: baseUrl } : {}),
      ...(req.signal ? { signal: req.signal } : {}),
    })
    return {
      text: result.text,
      ...(result.finishReason ? { finishReason: result.finishReason } : {}),
      ...(result.usage
        ? {
            usage: {
              ...(result.usage.inputTokens != null
                ? { inputTokens: result.usage.inputTokens }
                : {}),
              ...(result.usage.cacheReadTokens != null
                ? { cacheReadTokens: result.usage.cacheReadTokens }
                : {}),
              ...(result.usage.cacheWriteTokens != null
                ? { cacheWriteTokens: result.usage.cacheWriteTokens }
                : {}),
              ...(result.usage.outputTokens != null
                ? { outputTokens: result.usage.outputTokens }
                : {}),
            },
          }
        : {}),
    }
  }
}

/**
 * A {@link ModelProvider} that serves an enabled subscription harness ref inline — host CLI for a
 * native ambient vendor whose binary is present (unmetered, the developer's ambient login), else
 * the prewarmed container on a leased credential — and delegates everything else to `inner`.
 * Built PER-SCOPE so the container runner can lease the run's per-run activation (`scope`).
 */
class SubscriptionInlineModelProvider implements ModelProvider {
  constructor(
    private readonly inner: ModelProvider,
    private readonly scope: ModelScope,
    private readonly deps: InlineHarnessResolverDeps,
  ) {}

  resolve(ref: ModelRef): ReturnType<ModelProvider['resolve']> {
    const vendor = subscriptionVendorForRef(ref)
    // Not a subscription ref, or its harness isn't enabled inline → the inner provider decides.
    if (!vendor || !this.deps.inlineHarnesses.includes(SUBSCRIPTION_VENDORS[vendor].harness)) {
      return this.inner.resolve(ref)
    }
    // Prefer the developer's OWN host CLI for a native ambient vendor when it's installed:
    // unmetered, ambient login, no lease. Requires the harness be in the ambient allow-list too
    // (that's what `isAmbientNativeVendor` + presence check together give).
    const nativeVendor = nativeVendorForRef(ref)
    if (
      nativeVendor &&
      this.deps.hostCliVendors.has(nativeVendor) &&
      isAmbientNativeVendor(this.deps.inlineHarnesses, nativeVendor)
    ) {
      return new CliInlineLanguageModel(
        ref.provider,
        ref.model,
        runnerForVendor(nativeVendor, this.deps.exec ?? spawnCliExec),
      )
    }
    // Otherwise run it in a warm container on a leased credential (the compatibility path — no
    // host CLI needed, works in mothership mode; serves non-native vendors too).
    return new CliInlineLanguageModel(
      ref.provider,
      ref.model,
      makeContainerRunner(vendor, ref, this.scope, this.deps),
    )
  }
}

/**
 * Wrap the Node model-provider resolver so a resolved provider serves enabled subscription
 * harness refs inline: the developer's host `claude`/`codex` CLI when present, else a warm
 * container on the LEASED subscription credential (personal per-run activation for an individual
 * vendor, pooled token otherwise). Passed to `buildNodeContainer` as `wrapModelProviderResolver`
 * in local mode; a no-op when no inline harnesses are enabled (`LOCAL_NATIVE_INLINE=off`). The
 * lease seams (`leasePersonalSubscriptionToken`/`leaseSubscriptionToken`) are supplied by
 * `buildNodeContainer` (built from the same subscription services the container executor uses).
 */
export function wrapResolverWithInlineHarness(
  deps: InlineHarnessResolverDeps,
): (inner: ModelProviderResolver) => ModelProviderResolver {
  return (inner) => ({
    async forScope(scope: ModelScope): Promise<ModelProvider> {
      const provider = await inner.forScope(scope)
      if (deps.inlineHarnesses.length === 0) return provider
      return new SubscriptionInlineModelProvider(provider, scope, deps)
    },
  })
}
