import { describe, expect, it } from 'vitest'
import type { LlmCallMetricPage } from '@cat-factory/kernel'
import { parsePromptMessages, toDebugLlmCallMessagesView } from './promptMessages.js'

describe('parsePromptMessages', () => {
  it('parses the proxy shape: string content, tool_calls, tool_call_id', () => {
    const delta = JSON.stringify([
      {
        role: 'assistant',
        content: 'On it.',
        tool_calls: [
          { id: 'call_1', function: { name: 'edit_file', arguments: '{"path":"a.ts"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'Validation failed for tool "edit_file"' },
    ])
    const messages = parsePromptMessages(delta, 11, 100)!
    // Absolute indexes: the delta sits on 11 elided messages, so parsed views of two calls
    // line up without the reader doing delta arithmetic.
    expect(messages.map((m) => m.index)).toEqual([11, 12])
    expect(messages[0]).toMatchObject({ role: 'assistant' })
    expect(messages[0]!.content.text).toBe('On it.')
    expect(messages[0]!.toolCalls).toHaveLength(1)
    expect(messages[0]!.toolCalls[0]!.name).toBe('edit_file')
    expect(messages[0]!.toolCalls[0]!.args.text).toBe('{"path":"a.ts"}')
    expect(messages[1]).toMatchObject({ role: 'tool', toolCallId: 'call_1' })
    expect(messages[1]!.content.text).toContain('Validation failed')
  })

  it('parses the harness transcript shape: vendor content blocks', () => {
    const delta = JSON.stringify([
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me check.' },
          { type: 'tool_use', name: 'Read', input: { file_path: '/a.ts' } },
        ],
      },
      { role: 'tool', content: { type: 'tool_result', content: 'file body here' } },
    ])
    const messages = parsePromptMessages(delta, 0, 100)!
    expect(messages[0]!.content.text).toContain('Let me check.')
    // The tool_use block surfaces as a tool call, not as lost content.
    expect(messages[0]!.toolCalls[0]).toMatchObject({ name: 'Read' })
    expect(messages[0]!.toolCalls[0]!.args.text).toContain('file_path')
    // A bare object content degrades to its JSON rather than failing the message.
    expect(messages[1]!.content.text).toContain('tool_result')
  })

  it('budgets every message INDEPENDENTLY, so a huge tool result cannot hide what follows', () => {
    const delta = JSON.stringify([
      { role: 'tool', content: 'x'.repeat(10_000) },
      { role: 'user', content: 'the question that matters' },
    ])
    const messages = parsePromptMessages(delta, 0, 25)!
    // In the raw view the second message sits 10k characters deep; here it shows its head.
    expect(messages[0]!.content).toMatchObject({ chars: 25, totalChars: 10_000, truncated: true })
    expect(messages[1]!.content.text).toBe('the question that matters')
  })

  it('degrades unrecognised shapes instead of failing the view for them', () => {
    const delta = JSON.stringify([
      { role: 'user', content: [{ type: 'image', data: 'AAAA' }] },
      { content: 'no role at all' },
      'a bare string entry',
    ])
    const messages = parsePromptMessages(delta, 0, 100)!
    // A part with no text keeps its SHAPE visible as a placeholder.
    expect(messages[0]!.content.text).toBe('[image]')
    expect(messages[1]!.role).toBe('unknown')
    expect(messages[1]!.content.text).toBe('no role at all')
    // A non-object entry survives as its JSON, role unknown.
    expect(messages[2]!.content.text).toContain('a bare string entry')
  })

  it('returns null for anything that is not a JSON array — never a guess', () => {
    expect(parsePromptMessages('', 0, 100)).toBeNull()
    expect(parsePromptMessages('not json', 0, 100)).toBeNull()
    expect(parsePromptMessages('{"role":"user"}', 0, 100)).toBeNull()
  })
})

describe('toDebugLlmCallMessagesView', () => {
  const call = (promptText: string): LlmCallMetricPage => ({
    id: 'llm_1',
    workspaceId: 'ws',
    executionId: 'exec_1',
    agentKind: 'coder',
    provider: 'openai',
    model: 'gpt',
    createdAt: 5,
    streaming: true,
    phase: 'agent',
    turnIndex: null,
    spendOnly: false,
    messageCount: 3,
    toolCount: 3,
    requestMaxTokens: 1_000,
    promptTokens: 900,
    cacheReadTokens: 100,
    cacheWriteTokens: 0,
    completionTokens: 10,
    totalTokens: 1_010,
    finishReason: 'stop',
    upstreamMs: 100,
    overheadMs: 10,
    totalMs: 110,
    ok: true,
    httpStatus: 200,
    errorMessage: null,
    promptPrefixCount: 1,
    prompt: { text: promptText, totalChars: promptText.length },
    response: { text: 'the visible reply', totalChars: 17 },
    reasoning: { text: '', totalChars: 0 },
  })

  it('returns parsed messages with the raw prompt as sizes only (same bytes, one presentation)', () => {
    const delta = JSON.stringify([
      { role: 'assistant', content: 'ack' },
      { role: 'tool', content: 'result' },
    ])
    const view = toDebugLlmCallMessagesView(call(delta), 50, 0)
    expect(view.promptMessages).toHaveLength(2)
    expect(view.promptMessages![0]!.index).toBe(1) // on top of the elided prefix
    expect(view.prompt).toMatchObject({ text: '', chars: 0, totalChars: delta.length })
    // Response/reasoning are plain text and take the window exactly as the raw view would.
    expect(view.response.text).toBe('the visible reply')
  })

  it('degrades to the raw window with promptMessages: null when the delta does not parse', () => {
    const view = toDebugLlmCallMessagesView(call('garbled ‰ not json'), 7, 0)
    expect(view.promptMessages).toBeNull()
    // The caller still gets what a raw read would have returned — the view never serves LESS.
    expect(view.prompt.text).toBe('garbled')
    expect(view.prompt.truncated).toBe(true)
  })
})
