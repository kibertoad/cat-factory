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

/** One-shot CLI invocation: feed the prompt over stdin, collect stdout, reject on non-zero exit. */
function runCli(
  command: string,
  args: string[],
  stdin: string,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error(`${command} aborted before start`))
      return
    }
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    child.stdin.on('error', () => {})
    child.stdin.end(stdin)
    let stdout = ''
    let stderr = ''
    let aborted = false
    const onAbort = (): void => {
      aborted = true
      child.kill('SIGTERM')
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
      if (stderr.length > 8_000) stderr = stderr.slice(-8_000)
    })
    child.on('error', (err) => {
      signal?.removeEventListener('abort', onAbort)
      reject(err)
    })
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort)
      if (aborted) {
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
}

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

/**
 * Run one inline completion through the ambient `claude` CLI (`--output-format json`), which
 * returns a single result object `{ result, usage, subtype }`. The role rides
 * `--append-system-prompt`; the prompt goes over stdin. Bypass permissions so the headless run
 * never blocks on an approval prompt (an inline text task uses no tools anyway).
 */
const runClaudeInline: InlineCliRunner = async (req: InlineCliRequest): Promise<InlineCliResult> => {
  const args = ['-p', '--output-format', 'json', '--permission-mode', 'bypassPermissions']
  if (req.system.trim()) args.push('--append-system-prompt', req.system)
  args.push('--model', req.model)
  const stdout = await runCli('claude', args, req.prompt, req.signal)
  try {
    const parsed = JSON.parse(stdout) as Record<string, unknown>
    const text = typeof parsed.result === 'string' ? parsed.result : ''
    return { text, finishReason: 'stop', usage: claudeUsage(parsed.usage) }
  } catch {
    // Not JSON (older CLI / a wrapper line) — fall back to the raw text.
    return { text: stdout.trim(), finishReason: 'stop' }
  }
}

/**
 * Run one inline completion through the ambient `codex` CLI. Codex has no system-prompt flag, so
 * the composed role is prepended to the prompt (as the harness does), and `codex exec` prints the
 * final assistant message to stdout. Sandbox/approvals are bypassed (the developer's own machine).
 */
const runCodexInline: InlineCliRunner = async (req: InlineCliRequest): Promise<InlineCliResult> => {
  const prompt = req.system.trim() ? `${req.system}\n\n---\n\n${req.prompt}` : req.prompt
  const args = [
    'exec',
    '--skip-git-repo-check',
    '--dangerously-bypass-approvals-and-sandbox',
    '--model',
    req.model,
    '-',
  ]
  const stdout = await runCli('codex', args, prompt, req.signal)
  return { text: stdout.trim(), finishReason: 'stop' }
}

function runnerForVendor(vendor: SubscriptionVendor): InlineCliRunner {
  return vendor === 'codex' ? runCodexInline : runClaudeInline
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
  ) {}

  resolve(ref: ModelRef): ReturnType<ModelProvider['resolve']> {
    const vendor = nativeVendorForRef(ref)
    if (vendor && isAmbientNativeVendor(this.nativeAmbientAuth, vendor)) {
      return new CliInlineLanguageModel(ref.provider, ref.model, runnerForVendor(vendor))
    }
    return this.inner.resolve(ref)
  }
}

/**
 * Wrap the Node model-provider resolver so every resolved provider serves ambient-eligible
 * subscription harness refs inline via the developer's CLI. Passed to `buildNodeContainer` as
 * `wrapModelProviderResolver` in local mode; a no-op wrapper when no native harnesses are enabled.
 */
export function wrapResolverWithInlineHarness(
  nativeAmbientAuth: readonly HarnessKind[] | undefined,
): (inner: ModelProviderResolver) => ModelProviderResolver {
  return (inner) => ({
    async forScope(scope: ModelScope): Promise<ModelProvider> {
      const provider = await inner.forScope(scope)
      if (!nativeAmbientAuth || nativeAmbientAuth.length === 0) return provider
      return new HarnessInlineModelProvider(provider, nativeAmbientAuth)
    },
  })
}
