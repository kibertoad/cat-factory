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
  type HarnessKind,
  isAmbientNativeVendor,
  isIndividualVendor,
  type ModelProvider,
  type ModelProviderResolver,
  type ModelRef,
  type ModelScope,
  nativeVendorForRef,
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

/** The default {@link CliExec}: a real `node:child_process` spawn with a timeout watchdog.
 * Exported for its own tests (the sanitized-env contract); callers use the runner builders. */
export const spawnCliExec: CliExec = (command, args, stdin, opts = {}) =>
  new Promise((resolve, reject) => {
    const { signal, timeoutMs = DEFAULT_CLI_TIMEOUT_MS } = opts
    if (signal?.aborted) {
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
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
      if (stderr.length > 8_000) stderr = stderr.slice(-8_000)
    })
    child.on('error', (err) => {
      cleanup()
      reject(err)
    })
    child.on('close', (code) => {
      cleanup()
      if (killedReason === 'timeout') {
        reject(new Error(`${command} timed out after ${timeoutMs}ms`))
        return
      }
      if (killedReason === 'aborted') {
        reject(new Error(`${command} aborted`))
        return
      }
      if (code !== 0) {
        reject(new Error(`${command} exited with code ${code}: ${stderr.slice(-700)}`))
        return
      }
      resolve(stdout)
    })
  })

/** Sum Anthropic input buckets (fresh + cache read/write) the CLI reports, mirroring the harness. */
function claudeUsage(raw: unknown): InlineCliResult['usage'] {
  if (typeof raw !== 'object' || raw === null) return undefined
  const r = raw as Record<string, unknown>
  const num = (v: unknown): number => (typeof v === 'number' ? v : 0)
  const input =
    num(r.input_tokens) + num(r.cache_read_input_tokens) + num(r.cache_creation_input_tokens)
  const output = num(r.output_tokens)
  if (input === 0 && output === 0) return undefined
  return { inputTokens: input, outputTokens: output }
}

// Claude Code reports failures IN-BAND (process exit 0) via `is_error` / an `error_*` subtype,
// with the error text in `result`. Left unchecked, that error string would be handed back as a
// "successful" reviewer answer and parsed as a real (garbage) review; surface it as a throw so
// the run fails instead. (These one-shot CLIs expose no token-length stop reason, so a genuine
// output-cap truncation still reads as `stop` — the reviewer's `finishReason === 'length'`
// guard only fires for HTTP providers. `error_max_turns` is the closest limit signal they give.)
const CLAUDE_ERROR_SUBTYPES = new Set(['error_max_turns', 'error_during_execution'])

/**
 * A runner for the ambient `claude` CLI (`--output-format json`), which returns a single result
 * object `{ result, usage, subtype, is_error }`. The role rides `--append-system-prompt`; the
 * prompt goes over stdin. Bypass permissions so the headless run never blocks on an approval
 * prompt (an inline text task uses no tools anyway).
 */
function makeClaudeRunner(exec: CliExec): InlineCliRunner {
  return async (req: InlineCliRequest): Promise<InlineCliResult> => {
    const args = ['-p', '--output-format', 'json', '--permission-mode', 'bypassPermissions']
    if (req.system.trim()) args.push('--append-system-prompt', req.system)
    args.push('--model', req.model)
    const stdout = await exec('claude', args, req.prompt, req.signal ? { signal: req.signal } : {})
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(stdout) as Record<string, unknown>
    } catch {
      // Not JSON (older CLI / a wrapper line) — fall back to the raw text.
      return { text: stdout.trim(), finishReason: 'stop' }
    }
    const subtype = typeof parsed.subtype === 'string' ? parsed.subtype : undefined
    if (parsed.is_error === true || (subtype && CLAUDE_ERROR_SUBTYPES.has(subtype))) {
      const detail = typeof parsed.result === 'string' ? parsed.result : (subtype ?? 'error')
      throw new Error(
        `claude reported an error (${subtype ?? 'is_error'}): ${detail.slice(0, 700)}`,
      )
    }
    const text = typeof parsed.result === 'string' ? parsed.result : ''
    return { text, finishReason: 'stop', usage: claudeUsage(parsed.usage) }
  }
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
