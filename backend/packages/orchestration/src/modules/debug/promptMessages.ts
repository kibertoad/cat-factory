import type { LlmCallMetricPage } from '@cat-factory/kernel'
import type { DebugLlmCall, DebugPromptMessage } from '@cat-factory/contracts'
import { sliceText, toDebugLlmCall } from './debug.logic.js'

// The `?view=messages` half of the single-call point read: parse the stored prompt delta —
// `JSON.stringify` of a `{ role, content }` array on BOTH telemetry producers (the proxy
// stores the OpenAI-shaped request messages; the harness stores its reconstructed
// transcript) — into per-message rows, each with its OWN content budget.
//
// Independent budgets are the reason this exists rather than leaving the parse to the
// caller: in the raw view the delta is one string, so a 100 kB leading tool result must be
// paid for in full before anything after it is visible, while here every message shows its
// head. The response stays computable before the request — its worst case is
// `(messageCount − elidedLeadingMessages) × budget`, and both factors ride the list row.
//
// The parse is LENIENT BY CONTRACT. The two producers agree on the array-of-role-content
// envelope but not on content shapes (strings, OpenAI content parts + `tool_calls`, vendor
// tool_use/tool_result blocks), and the text is model-adjacent data that can be anything.
// So: an unparseable delta degrades the whole view to raw (`promptMessages: null`, stated,
// never guessed at), and inside a parsed array every unrecognised shape degrades to a
// placeholder or a JSON dump rather than failing the message — a reader locating a tool
// error must never lose the whole view to one exotic content block.

/** Read a string property leniently off an untrusted parsed object. */
function stringField(value: Record<string, unknown>, key: string): string | null {
  const field = value[key]
  return typeof field === 'string' ? field : null
}

/**
 * Flatten one message's `content` to text. Handles the shapes the two producers actually
 * store — a plain string, an array of parts (OpenAI `{type:'text',text}` and vendor
 * `{type:'tool_use'|'tool_result',…}` blocks), a bare object — and stands in a `[type]`
 * placeholder for a part with no text, so the message's SHAPE survives even when its
 * content is not textual.
 */
function contentToText(content: unknown): string {
  if (content == null) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part
        if (part && typeof part === 'object') {
          const record = part as Record<string, unknown>
          const text = stringField(record, 'text')
          if (text != null) return text
          // A vendor tool_result block nests its payload under `content`.
          if ('content' in record && stringField(record, 'type') === 'tool_result') {
            return contentToText(record['content'])
          }
          return `[${stringField(record, 'type') ?? 'part'}]`
        }
        return `[${typeof part}]`
      })
      .join('\n')
  }
  if (typeof content === 'object') return JSON.stringify(content)
  return String(content)
}

/**
 * Collect the tool invocations an assistant turn requested, across both producers' shapes:
 * OpenAI `tool_calls: [{function:{name,arguments}}]` and vendor content blocks
 * `{type:'tool_use', name, input}`. Arguments are serialized and budgeted like content.
 */
function collectToolCalls(
  message: Record<string, unknown>,
  budget: number,
): DebugPromptMessage['toolCalls'] {
  const calls: DebugPromptMessage['toolCalls'] = []
  const openAi = message['tool_calls']
  if (Array.isArray(openAi)) {
    for (const entry of openAi) {
      if (!entry || typeof entry !== 'object') continue
      const fn = (entry as Record<string, unknown>)['function']
      const record = fn && typeof fn === 'object' ? (fn as Record<string, unknown>) : {}
      const args = record['arguments']
      calls.push({
        name: stringField(record, 'name') ?? 'unknown',
        args: sliceText(
          typeof args === 'string' ? args : args == null ? '' : JSON.stringify(args),
          budget,
        ),
      })
    }
  }
  const content = message['content']
  if (Array.isArray(content)) {
    for (const part of content) {
      if (!part || typeof part !== 'object') continue
      const record = part as Record<string, unknown>
      if (stringField(record, 'type') !== 'tool_use') continue
      const input = record['input']
      calls.push({
        name: stringField(record, 'name') ?? 'unknown',
        args: sliceText(input == null ? '' : JSON.stringify(input), budget),
      })
    }
  }
  return calls
}

/**
 * Parse a stored prompt delta into per-message rows, or null when it is not a JSON array —
 * the caller degrades the view to raw and SAYS so, rather than serving a guess.
 *
 * `elided` is the call's `promptPrefixCount`: each row's `index` is its position in the
 * FULL conversation, so two calls' parsed views line up without the reader doing delta
 * arithmetic. `budget` bounds each message's content (and each tool call's arguments)
 * independently.
 */
export function parsePromptMessages(
  promptJson: string,
  elided: number,
  budget: number,
): DebugPromptMessage[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(promptJson)
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null
  return parsed.map((entry, position) => {
    const message =
      entry && typeof entry === 'object' && !Array.isArray(entry)
        ? (entry as Record<string, unknown>)
        : null
    return {
      index: elided + position,
      role: message ? (stringField(message, 'role') ?? 'unknown') : 'unknown',
      name: message ? stringField(message, 'name') : null,
      toolCallId: message ? stringField(message, 'tool_call_id') : null,
      toolCalls: message ? collectToolCalls(message, budget) : [],
      content: sliceText(
        message ? contentToText(message['content']) : JSON.stringify(entry),
        budget,
      ),
    }
  })
}

/**
 * Project a WHOLE-BODY row onto the wire shape as the parsed messages view. Takes the row
 * unsliced (the parse needs the complete delta — a truncated JSON array parses as nothing),
 * so the raw/messages split is decided here, in one place:
 *
 *  - parsed: `prompt` carries sizes only (its text is the same bytes re-presented as
 *    `promptMessages`, and sending both would double the payload), each message budgeted
 *    independently.
 *  - unparseable: `promptMessages: null` and the raw window served exactly as `view=raw`
 *    would have — the view DEGRADES, it never returns less than the raw read.
 *
 * `response`/`reasoning` are plain text either way and take the same window raw view does.
 */
export function toDebugLlmCallMessagesView(
  call: LlmCallMetricPage,
  bodyChars: number,
  bodyOffset: number,
): DebugLlmCall {
  const messages = parsePromptMessages(call.prompt.text, call.promptPrefixCount, bodyChars)
  // Project the metadata off body-less slices (the three bodies are replaced below), so the
  // full texts are not walked a second time just to produce fields that get overwritten.
  const projected = toDebugLlmCall({
    ...call,
    prompt: { text: '', totalChars: call.prompt.totalChars },
    response: { text: '', totalChars: call.response.totalChars },
    reasoning: { text: '', totalChars: call.reasoning.totalChars },
  })
  return {
    ...projected,
    prompt:
      messages == null
        ? sliceText(call.prompt.text, bodyChars, bodyOffset)
        : sliceText(call.prompt.text, 0),
    response: sliceText(call.response.text, bodyChars, bodyOffset),
    reasoning: sliceText(call.reasoning.text, bodyChars, bodyOffset),
    promptMessages: messages,
  }
}
