import { describe, expect, it } from 'vitest'
import { renderResult } from '../src/result.ts'

// The rules a tool RESULT has to hold that the end-to-end tests next door cannot provoke, because
// they need the deployment to answer with something the published schema does not describe. Every
// one of them is about the same obligation: a tool that declares an `outputSchema` may not answer
// successfully without structured content, or the caller's own client raises a protocol error the
// model never sees.

describe('renderResult', () => {
  it('says a 204 answered rather than rendering nothing', () => {
    // No output schema is declared for an operation with no body, so there is no obligation here and
    // "it worked, there is nothing to return" is the honest answer.
    const result = renderResult(undefined, { toolName: 'tasks_delete' })
    expect(result.isError).toBeUndefined()
    expect(result.content[0]!.text).toContain('returns no content')
  })

  it('refuses an empty body from an operation whose schema promises an object', () => {
    // The asymmetry that matters: the SAME undefined is a fine answer above and a version mismatch
    // here, and the difference is whether a schema was published for it. Left as a success it would
    // reach the caller's client as `structuredContent` missing, which is a protocol error and is not
    // shown to the model at all.
    const result = renderResult(undefined, { toolName: 'tasks_get', structured: true })
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toBeUndefined()
    expect(result.content[0]!.text).toContain('no body at all')
    expect(result.content[0]!.text).toContain('compatible versions')
  })

  it('refuses a non-object where the schema describes one, and shows what came back', () => {
    const result = renderResult([1, 2], { toolName: 'tasks_get', structured: true })
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toContain('returned a array')
    // The response itself, because a mismatch nobody can see the shape of is not diagnosable.
    expect(result.content[0]!.text).toContain('[1,2]')
  })

  it('returns both halves, compact, when the value fits the declared shape', () => {
    const result = renderResult({ taskId: 'blk_1' }, { toolName: 'tasks_get', structured: true })
    expect(result.isError).toBeUndefined()
    expect(result.structuredContent).toEqual({ taskId: 'blk_1' })
    expect(result.content[0]!.text).toBe('{"taskId":"blk_1"}')
  })

  it('refuses an over-cap result without structured content, so the client does not throw', () => {
    // A refusal carries `isError`, which is the one thing that releases the tool from the
    // structured-content obligation. Answering over-cap as a SUCCESS with no structured half would
    // turn a size problem into a protocol error.
    const result = renderResult(
      { text: 'x'.repeat(500) },
      {
        toolName: 'debug_get_agent_context',
        structured: true,
        maxChars: 100,
      },
    )
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toBeUndefined()
    expect(result.content[0]!.text).toContain('100-character limit')
    expect(result.content[0]!.text).toContain('CAT_FACTORY_MCP_MAX_RESULT_CHARS')
  })
})
