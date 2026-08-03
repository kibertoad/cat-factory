import { createRecordingLogger } from '@cat-factory/kernel'
import { afterEach, describe, expect, it } from 'vitest'
import {
  bedrockModelsCapability,
  clearModelRegistries,
  registerModelRegistry,
} from '../src/infrastructure/ai/registries'
import type { Env } from '../src/infrastructure/env'

// The Worker does not bundle `@cat-factory/provider-bedrock`; a deployment mixes it in via
// `registerModelRegistry`. Unlike Node, where `BEDROCK_REGION` also registers the resolver
// (so the env alone proves the route is dispatchable), the env vars here prove nothing: the
// capability must stay off until a registered registry can serve `provider: 'bedrock'`, or
// the picker would offer rows whose dispatch fails on an unregistered provider.

const env = {
  BEDROCK_REGION: 'eu-central-1',
  BEDROCK_MODELS: 'eu.anthropic.claude-opus-4-8, openai.gpt-5.5',
} as Env

const neverResolves = () => {
  throw new Error('these tests never resolve a model')
}

afterEach(() => clearModelRegistries())

describe('bedrockModelsCapability', () => {
  it('grants the parsed allow-list, order preserved, when a registered registry serves bedrock', () => {
    registerModelRegistry(() => ({ bedrock: neverResolves }))
    expect([...(bedrockModelsCapability(env) ?? [])]).toEqual([
      'eu.anthropic.claude-opus-4-8',
      'openai.gpt-5.5',
    ])
  })

  it('stays off when nothing is registered, warning once and naming the missing mix-in', () => {
    const log = createRecordingLogger()
    expect(bedrockModelsCapability(env, log)).toBeUndefined()
    expect(bedrockModelsCapability(env, log)).toBeUndefined()
    const warns = log.lines.filter((line) => line.level === 'warn')
    expect(warns).toHaveLength(1)
    expect(warns[0]!.msg).toContain('registerModelRegistry')
  })

  it('stays off when the registered registries serve other providers', () => {
    registerModelRegistry(() => ({ litellm: neverResolves }))
    expect(bedrockModelsCapability(env, createRecordingLogger())).toBeUndefined()
  })

  it('contributes nothing without BEDROCK_MODELS, registered or not', () => {
    registerModelRegistry(() => ({ bedrock: neverResolves }))
    expect(
      bedrockModelsCapability({ BEDROCK_REGION: 'eu-central-1' } as Env, createRecordingLogger()),
    ).toBeUndefined()
  })
})
