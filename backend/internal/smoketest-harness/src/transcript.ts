import { parseTodoProgress } from '@cat-factory/executor-harness/embed'
import type { PiEvent } from './types'

// Renders the captured Pi event stream into a human-readable markdown
// conversation. Best-effort and defensive: the authoritative capture is the raw
// `transcript.jsonl` (which includes the full `agent_end` transcript = every
// prompt and response); this view is for skimming what the agent actually did.

const MAX_CHARS = 1500

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function truncate(text: string, max = MAX_CHARS): string {
  const t = text.trim()
  return t.length > max ? `${t.slice(0, max)}\n… (${t.length - max} more chars)` : t
}

/** Join the text parts of a Pi message whose content is a string or parts array. */
function messageText(message: unknown): string {
  if (!isObject(message)) return ''
  const content = message.content
  if (typeof content === 'string') return content.trim()
  if (Array.isArray(content)) {
    return content
      .map((part) => (isObject(part) && typeof part.text === 'string' ? part.text : ''))
      .join('')
      .trim()
  }
  return ''
}

/** Tool calls declared inside an assistant message's content parts. */
function toolCalls(message: unknown): { name: string; args: unknown }[] {
  if (!isObject(message) || !Array.isArray(message.content)) return []
  const calls: { name: string; args: unknown }[] = []
  for (const part of message.content) {
    if (!isObject(part) || part.type !== 'toolCall') continue
    const name =
      (typeof part.toolName === 'string' && part.toolName) ||
      (typeof part.name === 'string' && part.name) ||
      'tool'
    const args = part.args ?? part.arguments ?? part.input
    calls.push({ name, args })
  }
  return calls
}

function compactArgs(args: unknown): string {
  if (args === undefined) return ''
  try {
    return truncate(JSON.stringify(args), 400)
  } catch {
    return ''
  }
}

function toolResultText(event: PiEvent): string {
  const m = isObject(event.message) ? event.message : event
  for (const key of ['output', 'content', 'text', 'result']) {
    const v = (m as Record<string, unknown>)[key]
    if (typeof v === 'string' && v.trim()) return v
    if (isObject(v) && typeof (v as Record<string, unknown>).output === 'string') {
      return (v as { output: string }).output
    }
  }
  return ''
}

/** Render one event to a markdown block, or null to skip it. */
function renderEvent(event: PiEvent): string | null {
  const todo = parseTodoProgress(event)
  if (todo) {
    const items = todo.items?.length
      ? `\n${todo.items.map((i) => `  - [${markFor(i.status)}] ${i.label}`).join('\n')}`
      : ''
    return `📋 **todo** — ${todo.completed}/${todo.total} done, ${todo.inProgress} in progress${items}`
  }

  if (event.type === 'message_end' && isObject(event.message)) {
    const role = (event.message as { role?: unknown }).role
    if (role === 'assistant') {
      const text = messageText(event.message)
      const calls = toolCalls(event.message)
      const parts: string[] = []
      if (text) parts.push(`🤖 **assistant**\n\n${truncate(text)}`)
      for (const c of calls) {
        const args = compactArgs(c.args)
        parts.push(`→ **${c.name}**${args ? `\n\n\`\`\`json\n${args}\n\`\`\`` : ''}`)
      }
      return parts.length ? parts.join('\n\n') : null
    }
    return null
  }

  if (event.type === 'tool_execution_end') {
    const name = String(event.toolName ?? 'tool')
    const mark = event.isError === true ? '❌ ERROR' : '✓'
    const body = truncate(toolResultText(event), 600)
    return `← **${name}** ${mark}${body ? `\n\n\`\`\`\n${body}\n\`\`\`` : ''}`
  }

  if (event.type === 'auto_retry_end' && event.success === false) {
    return `⚠️ **auto-retry exhausted** — ${String(event.finalError ?? 'model call failed')}`
  }

  if (event.type === 'agent_end') {
    const stop = typeof event.stopReason === 'string' ? ` (stopReason: ${event.stopReason})` : ''
    const errMsg =
      event.stopReason === 'error' && typeof event.errorMessage === 'string'
        ? `\n\n${event.errorMessage}`
        : ''
    return `— **agent end**${stop}${errMsg}`
  }

  return null
}

function markFor(status: string): string {
  return status === 'completed' ? 'x' : status === 'in_progress' ? '~' : ' '
}

/** Render the whole captured stream into a readable conversation. */
export function renderTranscript(events: PiEvent[]): string {
  const blocks: string[] = []
  for (const event of events) {
    const rendered = renderEvent(event)
    if (rendered) blocks.push(rendered)
  }
  return blocks.length ? blocks.join('\n\n---\n\n') : '_(no renderable events captured)_'
}
