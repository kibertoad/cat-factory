import { generateText } from 'ai'
import { describe, expect, it } from 'vitest'
import { CliInlineLanguageModel, type InlineCliRequest } from './cli-inline.js'

// The CLI-backed inline LanguageModel adapts an injected one-shot runner (the developer's
// ambient claude/codex CLI, in local mode) to the AI SDK, so the inline services keep calling
// `generateText` unchanged. These assert the mapping: prompt in → runner → text/usage out.

describe('CliInlineLanguageModel', () => {
  it('flattens system + user prompt, runs the CLI runner, and returns its text', async () => {
    const seen: InlineCliRequest[] = []
    const model = new CliInlineLanguageModel('anthropic', 'claude-opus-4-8', async (req) => {
      seen.push(req)
      return {
        text: 'REVIEW OK',
        finishReason: 'stop',
        usage: { inputTokens: 12, outputTokens: 3 },
      }
    })

    const result = await generateText({
      model,
      system: 'You are a reviewer.',
      prompt: 'Review this task.',
    })

    expect(result.text).toBe('REVIEW OK')
    expect(seen).toHaveLength(1)
    expect(seen[0]!.model).toBe('claude-opus-4-8')
    expect(seen[0]!.system).toContain('You are a reviewer.')
    expect(seen[0]!.prompt).toContain('Review this task.')
  })

  it('surfaces a length finish reason (so the reviewer can reject a truncated doc)', async () => {
    const model = new CliInlineLanguageModel('anthropic', 'claude-opus-4-8', async () => ({
      text: 'partial…',
      finishReason: 'length',
    }))
    const result = await generateText({ model, prompt: 'go' })
    expect(result.finishReason).toBe('length')
  })

  it('propagates a runner failure to the caller', async () => {
    const model = new CliInlineLanguageModel('anthropic', 'claude-opus-4-8', () =>
      Promise.reject(new Error('claude exited with code 1')),
    )
    await expect(generateText({ model, prompt: 'go' })).rejects.toThrow(/claude exited/)
  })
})
