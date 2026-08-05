import { defineStructuredOutput } from '@cat-factory/agents'
import type { JudgeFactory, JudgeRegistry } from '@cat-factory/kernel'
import * as v from 'valibot'

// ---------------------------------------------------------------------------
// A WORKED EXAMPLE of a company-authored JUDGE — the fourth step-taxonomy bucket
// (see `docs/initiatives/judge-registry.md` and `backend/docs/custom-agents.md`).
//
// This is the thing a `StepCompletionResolver` could never be: an evaluator that can BLOCK
// or BOUNCE a run. The org's rule is "a task must implement what was asked and nothing
// else" — a scope-adherence rubric. Below the task's threshold the judge sends the work
// back to the Coder with the findings as its rework brief, and once the rework budget is
// spent it stops for a human rather than quietly letting the work through.
//
// Everything it supplies is a DIFFERENTIATOR. It writes no state machine, no threshold
// comparison, no park, no notification, no persistence — the engine's one generic judge
// driver owns all of that, exactly as it owns the polling-gate loop behind a `GateDefinition`.
// Note what is NOT here: no executor-harness change (the assessment is an inline LLM call),
// no migration (all state rides the run's step), and no facade wiring beyond passing the
// registry in.
// ---------------------------------------------------------------------------

/** The judge's step kind — what a pipeline places to run this rubric. */
export const SCOPE_JUDGE_KIND = 'scope-adherence'

/**
 * The org's scope-adherence rubric, shipped as the registration's DEFAULT.
 *
 * A workspace overrides it by authoring a prompt-library fragment with the id below — the
 * engine resolves it through the same `fragmentResolver` the prompt standards use, so the
 * override inherits that library's CRUD, tenancy and runtime symmetry and this package needs
 * no rubric storage of its own.
 */
export const SCOPE_RUBRIC_FRAGMENT_ID = 'frag_org_scope_adherence'

const SCOPE_RUBRIC = [
  'Score how faithfully the change implements the task AS ASKED, and nothing beyond it.',
  '',
  'Deduct for each of these, worst first:',
  '- Work the task did not ask for: unrelated refactors, drive-by renames, reformatting of',
  '  files the change had no reason to touch, or a new abstraction nobody requested.',
  '- Requirements of the task left unimplemented, or implemented only partially, without',
  '  saying so.',
  '- Behaviour changes outside the stated blast radius (other modules, other services, the',
  '  public API, persisted shapes) that the task did not call for.',
  '- Suppressed or weakened checks — a disabled test, a widened type, a swallowed error —',
  '  used to make the change pass rather than to make it correct.',
  '',
  'Do NOT deduct for: work the task explicitly asked for even when it is large, changes that',
  'are strictly necessary to make the asked-for work compile/pass, or matters of style. Those',
  'belong to other reviews, not this one.',
].join('\n')

/**
 * The verdict shape. It EXTENDS the platform's canonical one (score + summary + findings) with
 * a field the org cares about, and derives the parser from the same valibot schema — the
 * `securityAssessment` pattern in this package, and the reason `JudgeDefinition.parseVerdict`
 * takes a parser rather than a schema (kernel carries no valibot dependency).
 *
 * Every field is `v.fallback`-wrapped so ONE noisy field degrades to its default instead of
 * discarding an otherwise-usable verdict. The exception is deliberate: a verdict that cannot be
 * read at all still fails, because the engine treats a thrown parse as a score-0 verdict — for
 * a gate that BLOCKS work, "I could not tell" must land on the cautious side, never the
 * permissive one.
 */
const scopeVerdict = defineStructuredOutput(
  v.object({
    score: v.fallback(v.pipe(v.number(), v.minValue(0), v.maxValue(1)), 0),
    summary: v.fallback(v.string(), ''),
    findings: v.optional(
      v.fallback(
        v.array(
          v.fallback(
            v.object({
              title: v.fallback(v.string(), 'Untitled finding'),
              detail: v.fallback(v.optional(v.string()), undefined),
              severity: v.fallback(
                v.picklist(['low', 'medium', 'high', 'critical'] as const),
                'medium',
              ),
              where: v.fallback(v.optional(v.string()), undefined),
            }),
            { title: 'Untitled finding', severity: 'medium' as const },
          ),
        ),
        [],
      ),
      [],
    ),
    /** The org's own extension: work the change did that the task never asked for. */
    outOfScopeAreas: v.optional(v.fallback(v.array(v.fallback(v.string(), '')), []), []),
  }),
)

/** The inferred verdict type — flows straight from the schema, no duplicate interface. */
export type ScopeVerdict = ReturnType<typeof scopeVerdict.parse>

/**
 * The judge factory. The engine invokes it ONCE at registry-build time with the shared
 * {@link JudgeContext}; this one needs none of those seams (its rubric is static and its
 * assessment runs through the engine's own assessor), which is exactly the point — a judge
 * that needs a provider reaches it through `ctx.getProvider`, like a gate.
 */
export const scopeAdherenceJudge: JudgeFactory = () => ({
  kind: SCOPE_JUDGE_KIND,
  rubric: {
    id: 'rubric_scope_adherence',
    name: 'Scope adherence',
    body: SCOPE_RUBRIC,
    fragmentId: SCOPE_RUBRIC_FRAGMENT_ID,
  },
  // The model this rubric was authored for. Judging scope means holding the whole task brief
  // against the whole diff, which the cheap kinds this org runs its ordinary steps on do badly,
  // and a rubric gate that is wrong is worse than no gate. It is a DEFAULT, not a seizure of the
  // workspace's settings: a task that pins its own model, or a preset row naming `scope-adherence`
  // in the model-defaults panel, still wins. A deployment whose catalog cannot serve this id runs
  // the assessment on its own default and says so on the step and the PR report, rather than
  // quietly scoring the work with a model this rubric was not written for.
  modelId: 'claude-opus',
  parseVerdict: scopeVerdict.parse,
  // Send the work back to the Coder rather than parking a human on every miss: an out-of-scope
  // diff is usually something the agent can fix from the findings alone. The engine parks only
  // once the task's rework budget is spent — never a silent advance.
  onFail: 'bounce',
  bounceTargets: ['coder'],
  presentation: {
    label: 'Scope Adherence',
    icon: 'i-lucide-scale',
    color: '#f59e0b',
    description:
      'Scores a change against the org rule: implement what was asked, and nothing else.',
    category: 'review',
  },
})

/** Register the example judge on the app-owned {@link JudgeRegistry} the composition root injects. */
export function registerExampleScopeJudge(judgeRegistry: JudgeRegistry): void {
  judgeRegistry.register(SCOPE_JUDGE_KIND, scopeAdherenceJudge)
}
