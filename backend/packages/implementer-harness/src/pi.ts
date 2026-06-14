import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)

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
 */
export async function runPi(opts: {
  cwd: string
  model: string
  userPrompt: string
  sessionToken: string
}): Promise<string> {
  const { stdout } = await exec(
    'pi',
    ['-p', '--mode', 'json', '--model', `proxy/${opts.model}`, '--approve', opts.userPrompt],
    {
      cwd: opts.cwd,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, PI_PROXY_TOKEN: opts.sessionToken },
    },
  )
  return parsePiOutput(stdout)
}

/**
 * Extract assistant text from Pi's JSON-lines output. Defensive about the exact
 * event shape: it collects text from the common fields and falls back to the raw
 * tail so a schema tweak never loses the summary.
 */
export function parsePiOutput(stdout: string): string {
  const parts: string[] = []
  for (const raw of stdout.split('\n')) {
    const line = raw.trim()
    if (!line.startsWith('{')) continue
    let event: unknown
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    const text = extractText(event)
    if (text) parts.push(text)
  }
  const joined = parts.join('\n').trim()
  if (joined) return joined
  // Nothing structured matched — return a trimmed tail of the raw output.
  return stdout.trim().slice(-2000)
}

/** Pull assistant text out of a single Pi event, tolerating several shapes. */
function extractText(event: unknown): string | null {
  if (typeof event !== 'object' || event === null) return null
  const o = event as Record<string, unknown>
  // Only assistant/message-type events carry summary text.
  const type = typeof o.type === 'string' ? o.type : ''
  if (type && !/assistant|message|text|result|final/i.test(type)) return null
  if (typeof o.text === 'string') return o.text
  if (typeof o.content === 'string') return o.content
  if (Array.isArray(o.content)) {
    const text = o.content
      .map((part) =>
        typeof part === 'object' &&
        part !== null &&
        typeof (part as { text?: unknown }).text === 'string'
          ? (part as { text: string }).text
          : '',
      )
      .join('')
    return text || null
  }
  const message = o.message
  if (typeof message === 'object' && message !== null) {
    const inner = (message as { content?: unknown }).content
    if (typeof inner === 'string') return inner
  }
  return null
}
