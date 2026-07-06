// A deterministic fake for the backend's INLINE LLM calls — the sibling of the
// `FakeAgentExecutor` (which fakes the CONTAINER/agent steps). Some pipelines run an inline
// LLM directly through the `ModelProvider` port rather than the agent executor: the initiative
// INTERVIEWER (`pl_initiative`), the document interviewer, the requirements reviewer. Those go
// through `container.modelProviderResolver`, NOT the faked agent executor, so on the e2e backend
// — which has NO real provider keys — they would fail deep in the AI SDK and fault the run.
//
// This resolver replaces the real per-scope key-pool resolver with one whose model is an
// `ai/test` mock that returns a fixed, immediately-CONVERGING interview decision. It makes the
// full-interview `pl_initiative` planning pipeline (interviewer → analyst → planner → committer)
// run deterministically end to end: the interviewer runs one pass over the seeded intake-form qa,
// converges (no questions), and the run advances to the analyst — exactly what the migration-preset
// e2e (T10) needs, and what any future inline-gate spec can reuse.
//
// It is injected GLOBALLY via `buildNodeContainer`'s `overrides.modelProviderResolver`. That is safe
// for the pre-existing specs: none of them assert on an inline-gate OUTCOME (a spawned document
// task's card is asserted on visibility, which is emitted at spawn regardless of how its later
// inline steps resolve), so a converging inline model changes no existing assertion — it only stops
// the interviewer from faulting the migration planning run.
import { MockLanguageModelV3 } from 'ai/test'
import type { buildNodeContainer } from '@cat-factory/node-server'

// Derive the resolver / provider shapes from the container's `overrides` contract, so this
// test-only package stays type-safe without a direct `@cat-factory/kernel` dependency (it has
// none) — mirrors how `testServer.ts` derives the fake-executor option types.
type Overrides = NonNullable<Parameters<typeof buildNodeContainer>[0]['overrides']>
type ModelProviderResolver = NonNullable<Overrides['modelProviderResolver']>
type ModelProvider = Awaited<ReturnType<ModelProviderResolver['forScope']>>
type LanguageModel = ReturnType<ModelProvider['resolve']>

// A synthesized "the interview has enough to plan" decision, in the exact JSON shape the
// interviewer's `coerceInterviewOutput` reads (`{ done, questions, goal, constraints, nonGoals }`).
// `done: true` + no questions → the interviewer converges on its first pass, so the planning run
// never parks for human answers and advances straight to the analyst. Migration-flavoured but
// generic; the interviewer's own prompt (which folds in the seeded qa) is unit-tested elsewhere.
const INTERVIEW_CONVERGENCE = JSON.stringify({
  done: true,
  questions: [],
  goal: 'Migrate the target technology to the new stack while preserving observable behaviour.',
  constraints: ['Preserve observable behaviour throughout the migration'],
  nonGoals: ['Zero-downtime online replication'],
})

/** A mock AI-SDK model that answers every inline generate with {@link INTERVIEW_CONVERGENCE}. */
function convergingModel(): LanguageModel {
  const model = new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: 'text' as const, text: INTERVIEW_CONVERGENCE }],
      finishReason: { unified: 'stop' as const, raw: undefined },
      usage: {
        inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 0, text: 0, reasoning: 0 },
      },
      warnings: [],
    }),
  })
  return model as unknown as LanguageModel
}

const provider: ModelProvider = { resolve: () => convergingModel() }

/**
 * A `ModelProviderResolver` that serves the converging inline model for every scope. Injected into
 * the e2e backend via `overrides.modelProviderResolver` so inline LLM gates (the initiative
 * interviewer, …) resolve deterministically instead of failing on the keyless e2e backend.
 */
export const fakeInlineModelResolver: ModelProviderResolver = {
  forScope: async () => provider,
}
