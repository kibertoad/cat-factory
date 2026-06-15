import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Drives the Pi coding-agent CLI. Pi is pointed at the Worker's OpenAI-compatible
// proxy via a custom provider in ~/.pi/agent/models.json, authenticated with the
// per-job session token (interpolated from $PI_PROXY_TOKEN) — so no provider key
// ever lives in the image or in Pi's config on disk.

/** Write the Pi provider config that routes all model calls through the proxy. */
export async function writePiModelsConfig(opts: {
  model: string
  proxyBaseUrl: string
}): Promise<string> {
  const dir = join(homedir(), '.pi', 'agent')
  await mkdir(dir, { recursive: true })
  const config = {
    providers: {
      proxy: {
        baseUrl: opts.proxyBaseUrl,
        api: 'openai-completions',
        // Interpolated by Pi from the environment at run time.
        apiKey: '$PI_PROXY_TOKEN',
        // OpenAI-compatible upstreams behind the proxy don't all accept the
        // `developer` role or `reasoning_effort`; send a plain system message.
        compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
        models: [{ id: opts.model, name: opts.model }],
      },
    },
  }
  const path = join(dir, 'models.json')
  await writeFile(path, JSON.stringify(config, null, 2), 'utf8')
  return path
}

/** Write the composed system prompt as project context Pi reads automatically. */
export async function writeAgentsContext(cwd: string, systemPrompt: string): Promise<void> {
  await writeFile(join(cwd, 'AGENTS.md'), systemPrompt, 'utf8')
}

/**
 * Run Pi non-interactively against `cwd` and return its assistant summary. Uses
 * print + JSON mode (`-p --mode json`) with `--approve` so it runs unattended.
 *
 * stdin is set to 'ignore' on purpose: print mode merges piped stdin into the
 * prompt, so an open (but empty) stdin pipe would make Pi block forever waiting
 * for EOF. Ignoring it gives an immediate EOF and Pi proceeds with the arg prompt.
 */
export function runPi(opts: {
  cwd: string
  model: string
  userPrompt: string
  sessionToken: string
  /** Aborting this kills Pi (the job's inactivity/max-duration watchdog). */
  signal?: AbortSignal
  /** Called on every chunk of Pi output, so the watchdog sees the agent is alive. */
  onActivity?: () => void
}): Promise<string> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new Error('pi aborted before start'))
      return
    }
    const child = spawn(
      'pi',
      ['-p', '--mode', 'json', '--model', `proxy/${opts.model}`, '--approve', opts.userPrompt],
      {
        cwd: opts.cwd,
        env: { ...process.env, PI_PROXY_TOKEN: opts.sessionToken },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    let stdout = ''
    let stderr = ''
    let aborted = false

    // When the watchdog aborts, terminate Pi: SIGTERM first, then SIGKILL if it
    // ignores it. The `close` handler then rejects with the abort reason.
    const onAbort = (): void => {
      aborted = true
      child.kill('SIGTERM')
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      }, 5_000).unref()
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true })

    const onChunk = (chunk: Buffer, sink: 'out' | 'err'): void => {
      if (sink === 'out') stdout += chunk.toString()
      else stderr += chunk.toString()
      // Any output means progress: reset the inactivity watchdog.
      opts.onActivity?.()
    }
    child.stdout.on('data', (chunk: Buffer) => onChunk(chunk, 'out'))
    child.stderr.on('data', (chunk: Buffer) => onChunk(chunk, 'err'))
    child.on('error', (error) => {
      opts.signal?.removeEventListener('abort', onAbort)
      reject(error)
    })
    child.on('close', (code) => {
      opts.signal?.removeEventListener('abort', onAbort)
      if (aborted) {
        reject(
          new Error(
            opts.signal?.reason instanceof Error ? opts.signal.reason.message : 'pi aborted',
          ),
        )
      } else if (code === 0) {
        resolve(parsePiOutput(stdout))
      } else {
        reject(new Error(`pi exited with code ${code}: ${(stderr || stdout).slice(-500)}`))
      }
    })
  })
}

/**
 * Extract the assistant's final summary from Pi's JSON-lines output. Pi emits a
 * terminal `agent_end` event whose `messages` is the full transcript, so the
 * last assistant message there is the canonical answer. Falls back to scanning
 * `message_end` events, then to a raw tail, so a schema tweak never loses output.
 */
export function parsePiOutput(stdout: string): string {
  const events: Record<string, unknown>[] = []
  for (const raw of stdout.split('\n')) {
    const line = raw.trim()
    if (!line.startsWith('{')) continue
    try {
      events.push(JSON.parse(line) as Record<string, unknown>)
    } catch {
      // Not a JSON event line; skip.
    }
  }

  // Preferred: the final transcript from the last agent_end event.
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!
    if (e.type === 'agent_end' && Array.isArray(e.messages)) {
      const text = lastAssistantText(e.messages as unknown[])
      if (text) return text
    }
  }

  // Fallback: assistant text accumulated from message_end events.
  const parts: string[] = []
  for (const e of events) {
    if (
      e.type === 'message_end' &&
      typeof e.message === 'object' &&
      e.message !== null &&
      (e.message as { role?: unknown }).role === 'assistant'
    ) {
      const text = messageText(e.message)
      if (text) parts.push(text)
    }
  }
  const joined = parts.join('\n').trim()
  if (joined) return joined

  // Nothing structured matched — return a trimmed tail of the raw output.
  return stdout.trim().slice(-2000)
}

/** The text of the last assistant message in a transcript, or '' if none. */
function lastAssistantText(messages: unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (typeof m === 'object' && m !== null && (m as { role?: unknown }).role === 'assistant') {
      const text = messageText(m)
      if (text) return text
    }
  }
  return ''
}

/** Join the text parts of a Pi message whose content is a string or parts array. */
function messageText(message: unknown): string {
  if (typeof message !== 'object' || message === null) return ''
  const content = (message as { content?: unknown }).content
  if (typeof content === 'string') return content.trim()
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === 'object' &&
        part !== null &&
        typeof (part as { text?: unknown }).text === 'string'
          ? (part as { text: string }).text
          : '',
      )
      .join('')
      .trim()
  }
  return ''
}
