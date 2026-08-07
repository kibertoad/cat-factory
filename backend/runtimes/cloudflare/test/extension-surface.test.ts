import { describe, expect, it } from 'vitest'
import * as worker from '../src/index'

// ---------------------------------------------------------------------------
// The Worker half of the extension-SURFACE guard (the authoritative classification of every
// app-owned seam lives in `runtimes/node/test/registry-seams.spec.ts`).
//
// This facade takes its registries as `overrides: Partial<CoreDependencies>`, so it accepts every
// seam by construction and the reachability half of that guard has nothing to say here. The half
// that DOES apply is the other one: a deployment still has to build a value, and until this change
// the only way to build a `GateRegistry`, a `JudgeRegistry`, a `StepResolverRegistry` or a
// `VcsProviderRegistry` was a direct `@cat-factory/kernel` / `@cat-factory/gates` dependency. Those
// publish as EXACT versions, so a consumer floating the range resolves a second physical copy and
// registers into the one the server does not read.
//
// The list below is a SYMMETRY copy, not a second source of truth: it must match what the Node and
// local facades publish (`registry-seams.spec.ts`'s `SEAM_CONSTRUCTORS`, and the derived superset
// check in `runtimes/local/test/registry-seams.spec.ts`). It is spelled out here rather than
// derived because this facade shares no dependency with the other two that could carry the table,
// and a runtime whose extension surface is a build behind the others is exactly the facade-parity
// gap the repo treats as a showstopper.
// ---------------------------------------------------------------------------

/** Every constructor a deployment needs to produce a value for a seam it may override. */
const REQUIRED_CONSTRUCTORS = [
  'AgentKindRegistry',
  'defaultAgentKindRegistry',
  'GateRegistry',
  'defaultGateRegistry',
  'gateRegistryWithBuiltins',
  'JudgeRegistry',
  'defaultJudgeRegistry',
  'StepResolverRegistry',
  'defaultStepResolverRegistry',
  'PipelineRegistry',
  'defaultPipelineRegistry',
  'TaskTypeRegistry',
  'defaultTaskTypeRegistry',
  'InitiativePresetRegistry',
  'defaultInitiativePresetRegistry',
  'VcsProviderRegistry',
  'defaultVcsRegistry',
  'FoundationalServiceRegistry',
  'defaultFoundationalServiceRegistry',
  'BinaryGeneratorRegistry',
  'defaultBinaryGeneratorRegistry',
  'PromptFragmentRegistry',
  'defaultPromptFragmentRegistry',
  'promptFragmentRegistryWithBuiltins',
  'createBackendRegistries',
] as const

describe('worker extension surface', () => {
  it('exports a way to CONSTRUCT every registry a deployment may override', () => {
    const exported = new Set(Object.keys(worker))
    // Every gap at once: these arrive in batches, and a guard that reports one per run trains the
    // reader to fix one per run.
    expect(REQUIRED_CONSTRUCTORS.filter((name) => !exported.has(name))).toEqual([])
  })
})
