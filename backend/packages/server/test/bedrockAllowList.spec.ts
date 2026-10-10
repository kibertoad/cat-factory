import { describe, expect, it } from 'vitest'
import { bedrockAllowListFromEnv, bedrockRegionFromEnv } from '../src/agents/bedrock.js'

// The ONE parse of `BEDROCK_REGION` / `BEDROCK_MODELS`, feeding both the Bedrock resolver's
// allow-list and the model catalog's `bedrock` capability. Two properties are load-bearing
// beyond ordinary parsing: the region gate must agree with the Node facade's registration
// gate (a whitespace-only region enables nothing on either side), and the returned Set's
// ITERATION ORDER is the operator's declared order, which `resolveBedrockModelId` uses to
// pick between two inference profiles for one model.

describe('bedrockRegionFromEnv', () => {
  it('returns the region trimmed', () => {
    expect(bedrockRegionFromEnv({ BEDROCK_REGION: ' eu-central-1 ' })).toBe('eu-central-1')
  })

  it('treats unset and whitespace-only the same: not configured', () => {
    expect(bedrockRegionFromEnv({})).toBeUndefined()
    expect(bedrockRegionFromEnv({ BEDROCK_REGION: '' })).toBeUndefined()
    expect(bedrockRegionFromEnv({ BEDROCK_REGION: '   ' })).toBeUndefined()
  })
})

describe('bedrockAllowListFromEnv', () => {
  it('contributes nothing without a region, models listed or not', () => {
    expect(bedrockAllowListFromEnv({ BEDROCK_MODELS: 'anthropic.claude-opus-4-8' })).toBeUndefined()
    expect(
      bedrockAllowListFromEnv({
        BEDROCK_REGION: '  ',
        BEDROCK_MODELS: 'anthropic.claude-opus-4-8',
      }),
    ).toBeUndefined()
  })

  it('contributes nothing when the region is set but no model is named', () => {
    // The resolver then runs unconstrained (Bedrock stays a routing default), but with
    // nothing enumerated there is no per-model capability to grant.
    expect(bedrockAllowListFromEnv({ BEDROCK_REGION: 'us-east-1' })).toBeUndefined()
    expect(
      bedrockAllowListFromEnv({ BEDROCK_REGION: 'us-east-1', BEDROCK_MODELS: ' , ,' }),
    ).toBeUndefined()
  })

  it('trims entries and drops empty ones', () => {
    expect(
      bedrockAllowListFromEnv({
        BEDROCK_REGION: 'us-east-1',
        BEDROCK_MODELS: ' us.anthropic.claude-opus-4-8 ,, openai.gpt-5.5 ',
      }),
    ).toEqual(new Set(['us.anthropic.claude-opus-4-8', 'openai.gpt-5.5']))
  })

  it('preserves the declared order, which picks between two profiles for one model', () => {
    const models = bedrockAllowListFromEnv({
      BEDROCK_REGION: 'us-east-1',
      BEDROCK_MODELS: 'global.anthropic.claude-opus-4-8,us.anthropic.claude-opus-4-8',
    })
    expect([...(models ?? [])]).toEqual([
      'global.anthropic.claude-opus-4-8',
      'us.anthropic.claude-opus-4-8',
    ])
  })
})
