import { spawn } from 'node:child_process'
import {
  CliInlineLanguageModel,
  type InlineCliRequest,
  type InlineCliResult,
  type InlineCliRunner,
} from '@cat-factory/agents'
import {
  type HarnessKind,
  isAmbientNativeVendor,
  type ModelProvider,
  type ModelProviderResolver,
  type ModelRef,
  type ModelScope,
  nativeVendorForRef,
  type SubscriptionVendor,
} from '@cat-factory/kernel'

// Local-mode INLINE harness execution: run the developer's ambient `claude` / `codex` CLI as a
// host subprocess to serve the inline LLM steps (requirements reviewer, brainstorm,
// task-estimator, inline document kinds) on a subscription model — the inline analogue of the
// container ambient-auth path (`LOCAL_NATIVE_AGENTS`). Only NATIVE ambient vendors qualify
// (`claude` / `codex`, no injected credential); a non-native claude-code vendor (GLM/Kimi/
// DeepSeek) keeps degrading to a provider model, exactly as `nativeVendorForRef` /
// `isAmbientNativeVendor` gate the container path — so the guard's `inlineHarnessRef` predicate
// and this provider agree on what can run inline.

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

/** The default {@link CliExec}: a real `node:child_process` spawn with a timeout watchdog. */
const spawnCliExec: CliExec = (command, args, stdin, opts = {}) =>
  new Promise((resolve, reject) => {
    const { signal, timeoutMs = DEFAULT_CLI_TIMEOUT_MS } = opts
    if (signal?.aborted) {
      reject(new Error(`${command} aborted before start`))
      return
    }
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] })
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
 * Whether a ref can be served as an inline CLI call given the deployment's ambient allow-list —
 * the single predicate shared by the config (`inlineHarnessRef`, so the start guard treats such a
 * model as inline-satisfiable) and the provider wrapper below (so the two never disagree).
 */
export function makeInlineHarnessPredicate(
  nativeAmbientAuth: readonly HarnessKind[] | undefined,
): (ref: ModelRef) => boolean {
  return (ref) => {
    const vendor = nativeVendorForRef(ref)
    return !!vendor && isAmbientNativeVendor(nativeAmbientAuth, vendor)
  }
}

/** A {@link ModelProvider} that serves ambient-eligible harness refs via the CLI, else delegates. */
class HarnessInlineModelProvider implements ModelProvider {
  constructor(
    private readonly inner: ModelProvider,
    private readonly nativeAmbientAuth: readonly HarnessKind[],
    private readonly exec: CliExec = spawnCliExec,
  ) {}

  resolve(ref: ModelRef): ReturnType<ModelProvider['resolve']> {
    const vendor = nativeVendorForRef(ref)
    if (vendor && isAmbientNativeVendor(this.nativeAmbientAuth, vendor)) {
      return new CliInlineLanguageModel(ref.provider, ref.model, runnerForVendor(vendor, this.exec))
    }
    return this.inner.resolve(ref)
  }
}

/**
 * Wrap the Node model-provider resolver so every resolved provider serves ambient-eligible
 * subscription harness refs inline via the developer's CLI. Passed to `buildNodeContainer` as
 * `wrapModelProviderResolver` in local mode; a no-op wrapper when no native harnesses are enabled.
 * `exec` is the injectable CLI seam (defaults to a real spawn); tests pass a fake.
 */
export function wrapResolverWithInlineHarness(
  nativeAmbientAuth: readonly HarnessKind[] | undefined,
  exec: CliExec = spawnCliExec,
): (inner: ModelProviderResolver) => ModelProviderResolver {
  return (inner) => ({
    async forScope(scope: ModelScope): Promise<ModelProvider> {
      const provider = await inner.forScope(scope)
      if (!nativeAmbientAuth || nativeAmbientAuth.length === 0) return provider
      return new HarnessInlineModelProvider(provider, nativeAmbientAuth, exec)
    },
  })
}
