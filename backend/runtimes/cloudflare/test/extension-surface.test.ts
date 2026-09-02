import { describe, expect, it } from 'vitest'
import * as worker from '../src/index'
import * as kernel from '@cat-factory/kernel'
import type {
  CustomTaskType,
  DescriptorField,
  DescriptorFieldShowWhen,
  GateDefinition,
  JudgeDefinition,
  PromptFragment,
  // From the FACADE, not `@cat-factory/orchestration`: importing these from the package that
  // defines them would have let the facade stop exporting them with this guard still green, which
  // is the very reachability hole ADR 0044 closed.
  RegistrationProblem,
  RegistrationWarning,
  StepCompletionResolver,
  TaskTypeFieldDescriptor,
  TaskTypeFieldOption,
  TaskTypePresentation,
} from '../src/index'

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
  'InlineUseCaseRegistry',
  'defaultInlineUseCaseRegistry',
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

/**
 * The rest of the runtime surface a registration literal reaches for, which the constructor list
 * above says nothing about: the pure descriptor rules a deployment's own tests run against a form
 * it declares.
 *
 * Listed rather than derived, unlike the pipeline ids below, because these are a DECISION about what
 * the facade publishes rather than a mirror of a set kernel grows on its own.
 */
const REQUIRED_HELPERS = [
  'isDescriptorFieldVisible',
  'renderDescriptorFieldValue',
  'sanitizeDescriptorFields',
  'validateDescriptorFields',
] as const

/**
 * The TYPE half, which no runtime check can see: a deployment writing a registration literal names
 * its shape, and a type it cannot import from the facade is a direct `@cat-factory/contracts` or
 * `@cat-factory/orchestration` dependency carrying the same duplicate-copy hazard as a missing
 * constructor. Mirrors `runtimes/node/test/registry-seams.spec.ts`'s `_authoringVocabulary`.
 *
 * Enumerated because a type union is not reflectable; the compile error when one is missing is the
 * guard, and this value exists only to make the imports load-bearing.
 */
const _authoringVocabulary:
  | {
      taskType: CustomTaskType
      presentation: TaskTypePresentation
      field: TaskTypeFieldDescriptor
      option: TaskTypeFieldOption
      descriptorField: DescriptorField
      condition: DescriptorFieldShowWhen
      fragment: PromptFragment
      gate: GateDefinition
      judge: JudgeDefinition
      resolver: StepCompletionResolver
      // What `escalateRegistrationWarning` is handed. A deployment writing that predicate names it,
      // so it belongs to this surface exactly as the registration shapes above do. The predicate
      // takes the WARN half (the one carrying `subject`), and a deployment that collects problems
      // itself sees the whole union, whose error branch stays unexported.
      registrationProblem: RegistrationProblem
      registrationWarning: RegistrationWarning
    }
  | undefined = undefined

describe('worker extension surface', () => {
  it('exports a way to CONSTRUCT every registry a deployment may override', () => {
    const exported = new Set(Object.keys(worker))
    // Every gap at once: these arrive in batches, and a guard that reports one per run trains the
    // reader to fix one per run.
    expect(REQUIRED_CONSTRUCTORS.filter((name) => !exported.has(name))).toEqual([])
  })

  it('exports the descriptor rules a deployment checks its own form against', () => {
    const exported = new Set(Object.keys(worker))
    expect(REQUIRED_HELPERS.filter((name) => !exported.has(name))).toEqual([])
  })

  it('re-exports every built-in pipeline id kernel publishes', () => {
    // DERIVED from kernel, not listed: this set grows whenever the platform ships a pipeline, and a
    // hand-copied list is how two of them (`pl_spike`, `pl_ralph`) came to be missing from all three
    // facades at once, leaving a deployment pinning one to hard-code the string. Counting instead
    // would fail on the next ordinary addition while naming nothing.
    const published = Object.keys(kernel).filter((name) => name.endsWith('_PIPELINE_ID'))
    expect(published.length).toBeGreaterThan(0)
    const exported = new Set(Object.keys(worker))
    expect(published.filter((name) => !exported.has(name))).toEqual([])
  })

  it('names the authoring vocabulary a registration literal is typed against', () => {
    // Carried by the type annotation on `_authoringVocabulary`; the assertion exists so a missing
    // export fails a test rather than only a typecheck job the reader has to go find.
    expect(_authoringVocabulary).toBeUndefined()
  })
})
