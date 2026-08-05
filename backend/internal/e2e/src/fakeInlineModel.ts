// A deterministic fake for the backend's INLINE LLM calls — the sibling of the
// `FakeAgentExecutor` (which fakes the CONTAINER/agent steps). Some pipelines run an inline
// LLM directly through the `ModelProvider` port rather than the agent executor: the initiative
// INTERVIEWER (`pl_initiative`), the document interviewer, and the whole requirements-review
// loop (review → incorporate → re-review). Those go through `container.modelProviderResolver`,
// NOT the faked agent executor, so on the e2e backend — which has NO real provider keys — they
// would fail deep in the AI SDK and fault the run.
//
// It is injected via `buildNodeContainer`'s `overrides.modelProviderResolver` and answers each
// call by the SHAPE OF THE PROMPT it was handed (see {@link classifyInlineCall}), because that
// is the only thing an inline call carries that says which of the flow's three LLM steps it is.
// The engine builds those prompts, so the markers below are quotes of production strings:
// `requirements.logic.ts` (`buildReviewPrompt` / `buildReworkPrompt` / `renderRequirements`).
// Changing one of those lines is what `fakeInlineModel.test.ts` pins, so a marker cannot rot
// silently into "every call is an interview" (which reads as a reviewer that found nothing).
//
// WHAT it answers with is per-workspace, resolved from the same `FakeProfile` registry the fake
// agent and the gate providers read (`forScope` carries the `workspaceId`). A workspace with no
// profile gets the historical behaviour: a converging interview decision, and — since that JSON
// carries no `items` — a requirements review that raises nothing and auto-passes. So every
// pre-existing spec is byte-identical, and a spec that WANTS the reviewer to park scripts its
// findings with `reviewFindings`.
import { MockLanguageModelV3 } from 'ai/test'
import type { buildNodeContainer } from '@cat-factory/node-server'
import type { FakeProfile, FakeProfileRegistry, WorkspaceScopedFakes } from './fakeProfile.ts'

// Derive the resolver / provider shapes from the container's `overrides` contract, so this
// test-only package stays type-safe without a direct `@cat-factory/kernel` dependency (it has
// none) — mirrors how `testServer.ts` derives the fake-executor option types.
type Overrides = NonNullable<Parameters<typeof buildNodeContainer>[0]['overrides']>
type ModelProviderResolver = NonNullable<Overrides['modelProviderResolver']>
type ModelProvider = Awaited<ReturnType<ModelProviderResolver['forScope']>>
type LanguageModel = ReturnType<ModelProvider['resolve']>

/**
 * Which inline LLM call a prompt belongs to. The three requirements members are the flow's
 * three distinct calls; `interview` is the catch-all, and deliberately so: it is the answer that
 * changes nothing for a caller this fake does not model.
 */
export type InlineCallKind =
  | 'requirements-review'
  | 'requirements-re-review'
  | 'requirements-incorporate'
  | 'interview'

/**
 * Markers quoted from the production prompt builders, in the order they must be tested.
 *
 * The order is load-bearing, not cosmetic. Every one of these prompts embeds the SAME rendered
 * requirements block, so the later calls in the loop contain the earlier calls' markers too:
 * a re-review renders the incorporated document inside the review prompt, and a second
 * incorporation renders it inside the rework prompt. Testing the most specific call first is
 * what keeps "fold the answers in" from being read as "review this again".
 */
const INCORPORATE_MARKER = 'Rewrite the requirements as a single self-contained Markdown document'
const INCORPORATED_DOC_MARKER = 'Current standardized requirements (under review)'
const REVIEW_MARKER = 'Here are the collected requirements to review:'

/**
 * Classify one inline call from its prompt text. Pure, and exported so the browser-free vitest
 * lane can pin it against the production prompt builders' own strings: a drifted marker degrades
 * to `interview`, which a spec would only ever see as a reviewer that mysteriously found nothing.
 */
export function classifyInlineCall(prompt: string): InlineCallKind {
  if (prompt.includes(INCORPORATE_MARKER)) return 'requirements-incorporate'
  if (prompt.includes(INCORPORATED_DOC_MARKER) && prompt.includes(REVIEW_MARKER)) {
    return 'requirements-re-review'
  }
  if (prompt.includes(REVIEW_MARKER)) return 'requirements-review'
  return 'interview'
}

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

/** The document the incorporation companion returns when a profile names none. */
const DEFAULT_INCORPORATED_DOC = [
  '## Goal',
  '',
  'Deliver the requested change with the product questions settled.',
  '',
  '## Requirements',
  '',
  '- The behaviour agreed with the requester, as answered on the review findings.',
].join('\n')

/**
 * The reply this fake gives one call. The requirements reviewer coerces JSON
 * (`coerceReviewItems` reads `{ items: [...] }`); the incorporation companion's reply IS the
 * document, as prose. An empty `items` array is what makes a re-review CONVERGE, which is the
 * whole reason the re-review is classified apart from the first pass.
 */
export function inlineReplyFor(kind: InlineCallKind, profile: FakeProfile | undefined): string {
  switch (kind) {
    case 'requirements-review':
      return JSON.stringify({ items: profile?.reviewFindings ?? [] })
    case 'requirements-re-review':
      return JSON.stringify({ items: [] })
    case 'requirements-incorporate':
      return profile?.incorporatedRequirements ?? DEFAULT_INCORPORATED_DOC
    default:
      return INTERVIEW_CONVERGENCE
  }
}

/** Flatten an AI-SDK prompt (system + messages + content parts) to one searchable string. */
function promptText(prompt: unknown): string {
  return JSON.stringify(prompt) ?? ''
}

/**
 * The per-workspace inline-LLM fake: one `ai/test` mock model per workspace, answering each
 * generate from {@link classifyInlineCall} + that workspace's profile.
 *
 * A workspace's model is built on its FIRST inline call and reads the profile then, so a spec
 * `setFakeProfile`s BEFORE starting the run — exactly as it does for the agent executor and the
 * gate providers. A later write still lands, because {@link FakeProfileRegistry.set} re-arms this
 * cache along with the others.
 */
export class E2eInlineModels implements WorkspaceScopedFakes {
  private readonly byWs = new Map<string, ModelProvider>()
  private readonly registry: FakeProfileRegistry

  // A plain field + body assignment, NOT a `private readonly` parameter property: the e2e
  // backend runs under Node type-stripping, whose strip-only mode rejects parameter properties.
  // Mirrors `E2eGateProviders` / `E2eRepoBootstrapper`.
  constructor(registry: FakeProfileRegistry) {
    this.registry = registry
    registry.register(this)
  }

  resetWorkspace(workspaceId: string): void {
    this.byWs.delete(workspaceId)
  }

  // `ModelScope.workspaceId` is required, so unlike the agent executor there is no "no workspace"
  // case to key a fallback on.
  private forWorkspace(workspaceId: string): ModelProvider {
    let provider = this.byWs.get(workspaceId)
    if (!provider) {
      const profile = this.registry.get(workspaceId)
      provider = { resolve: () => this.model(profile) }
      this.byWs.set(workspaceId, provider)
    }
    return provider
  }

  private model(profile: FakeProfile | undefined): LanguageModel {
    const model = new MockLanguageModelV3({
      doGenerate: async ({ prompt }) => ({
        content: [
          {
            type: 'text' as const,
            text: inlineReplyFor(classifyInlineCall(promptText(prompt)), profile),
          },
        ],
        // Never `length`: the incorporation path REFUSES a length-truncated document (it would
        // become a silently-incomplete spec every downstream step then treats as authoritative),
        // so a careless finish reason here would read as a broken product rather than a fake.
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

  /** The seam `buildNodeContainer`'s `overrides.modelProviderResolver` takes. */
  readonly resolver: ModelProviderResolver = {
    forScope: async (scope) => this.forWorkspace(scope.workspaceId),
  }
}
