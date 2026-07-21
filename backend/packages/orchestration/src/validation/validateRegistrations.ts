import type { AgentKindRegistry } from '@cat-factory/agents'
import type { GateRegistry, PipelineRegistry, TaskTypeRegistry } from '@cat-factory/kernel'
import {
  CI_FIXER_AGENT_KIND,
  CONFLICT_RESOLVER_AGENT_KIND,
  FIXER_AGENT_KIND,
  ON_CALL_AGENT_KIND,
  seedPipelines,
  stubGateContext,
} from '@cat-factory/kernel'
import { isNamespacedId, isValidResultViewId, RESULT_VIEW_ID_SET } from '@cat-factory/contracts'

// ---------------------------------------------------------------------------
// Boot-time validation of the deployment's registered extensions (agent kinds, gates,
// pipelines). A typo'd gate `helperKind`, an unknown `resultView`, or a pipeline naming a
// kind that doesn't exist used to surface mid-run (a failed dispatch) or silently (a prose
// fallback). `validateRegistrations()` turns those into a LOUD startup error instead — a
// facade calls it once after all `register*` side-effect imports + provider wiring, before
// serving, so a misconfigured deployment fails fast at boot.
//
// This lives in orchestration because it cross-checks the gate registry (kernel) against the
// agent-kind registry (@cat-factory/agents) and the pipeline registry — only orchestration
// depends on all three.
// ---------------------------------------------------------------------------

/** Built-in container helper kinds a gate may escalate to (handled by the executor/harness,
 * not the custom-kind registry). A gate `helperKind` is valid if it's one of these or a
 * registered container-capable kind. */
const BUILT_IN_HELPER_KINDS: ReadonlySet<string> = new Set([
  CI_FIXER_AGENT_KIND,
  CONFLICT_RESOLVER_AGENT_KIND,
  ON_CALL_AGENT_KIND,
  // The human-review gate escalates to the `fixer` (a built-in container coding agent, also
  // the Tester's helper) to address review comments.
  FIXER_AGENT_KIND,
])

/** A single problem found during validation. `error` aborts boot; `warn` is logged only. */
export interface RegistrationProblem {
  severity: 'error' | 'warn'
  code: string
  message: string
}

/** Options for {@link collectRegistrationProblems} / {@link validateRegistrations}. */
export interface ValidateRegistrationsOptions {
  /**
   * The app-owned agent-kind registry to validate (the facade's injected instance). Required:
   * without it there are no registered kinds to cross-check the gates/pipelines against.
   */
  agentKindRegistry: AgentKindRegistry
  /**
   * The app-owned gate registry to validate (the facade's injected instance — the SAME one it
   * threads through `CoreDependencies.gateRegistry`). Required: the gate-helper + pipeline-kind
   * cross-checks read the registered gates from it rather than a module global.
   */
  gateRegistry: GateRegistry
  /**
   * The app-owned pipeline registry to validate (the facade's injected instance — the SAME one it
   * threads through `CoreDependencies.pipelineRegistry`). Optional: when omitted, no
   * deployment-registered pipelines are cross-checked (the pipeline-kind check still needs
   * `knownAgentKinds`). A facade that registers custom pipelines passes it so a pipeline naming a
   * nonexistent kind fails at boot rather than mid-run.
   */
  pipelineRegistry?: PipelineRegistry
  /**
   * The app-owned custom task-type registry to validate (the facade's injected instance — the
   * SAME one it threads through `CoreDependencies.taskTypeRegistry`). Optional: when omitted, no
   * task-type checks run. A facade that registers custom task types passes it so a malformed id,
   * a bad `formPanel`, or a `defaultPipelineId` naming a nonexistent pipeline fails at boot.
   */
  taskTypeRegistry?: TaskTypeRegistry
  /** Override the canonical result-view id set (defaults to contracts' {@link RESULT_VIEW_ID_SET}). */
  knownResultViewIds?: ReadonlySet<string>
  /** Built-in helper kinds a gate may escalate to (defaults to ci-fixer/conflict-resolver/on-call). */
  builtInHelperKinds?: ReadonlySet<string>
  /**
   * The known built-in agent-kind ids, for validating a registered pipeline's `agentKinds`.
   * The backend has no canonical runtime catalog of built-in kinds, so a pipeline-kind check
   * is only run when this is supplied (else built-in kinds like `coder` would false-positive);
   * unknown kinds are then ERRORS. Omitted ⇒ the pipeline-kind check is skipped.
   */
  knownAgentKinds?: ReadonlySet<string>
  /**
   * Sink for `warn`-severity problems (orchestration is runtime-neutral, so it never touches
   * `console`/a logger directly — the facade passes its logger). Omitted ⇒ warnings are dropped
   * (errors still throw).
   */
  onWarn?: (problem: RegistrationProblem) => void
}

/**
 * Collect every registration problem (does not throw). Useful for tests and for callers that
 * want to log warnings without aborting. {@link validateRegistrations} throws on any `error`.
 */
export function collectRegistrationProblems(
  opts: ValidateRegistrationsOptions,
): RegistrationProblem[] {
  const knownResultViewIds = opts.knownResultViewIds ?? RESULT_VIEW_ID_SET
  const builtInHelperKinds = opts.builtInHelperKinds ?? BUILT_IN_HELPER_KINDS
  const registry = opts.agentKindRegistry
  const problems: RegistrationProblem[] = []

  const agentKinds = registry.all()
  const registeredKindIds = new Set(agentKinds.map((d) => d.kind))
  const gateFactories = opts.gateRegistry.factories()
  const gateKinds = new Set(gateFactories.map((g) => g.kind))

  // 1. Every gate's helperKind must resolve to a registered container-capable kind or a
  //    built-in helper. The factory is a pure constructor, so we build it with a stub context
  //    just to read its declared helperKind.
  for (const { kind, factory } of gateFactories) {
    let helperKind: string
    try {
      helperKind = factory(stubGateContext()).helperKind
    } catch (err) {
      problems.push({
        severity: 'error',
        code: 'gate_factory_threw',
        message: `Gate "${kind}" factory threw while validating: ${(err as Error).message}`,
      })
      continue
    }
    const helperOk =
      builtInHelperKinds.has(helperKind) ||
      (registeredKindIds.has(helperKind) && registry.requiresContainer(helperKind))
    if (!helperOk) {
      problems.push({
        severity: 'error',
        code: 'gate_helper_unresolved',
        message:
          `Gate "${kind}" escalates to helperKind "${helperKind}", which is neither a ` +
          `built-in helper nor a registered container-capable agent kind. Register the helper ` +
          `(a container surface) or fix the helperKind.`,
      })
    }
  }

  // 2. Every registered kind's presentation.resultView must be a known BUILT-IN view id or a
  //    consumer-namespaced id (`<ns>:<name>`, paired to a deployment-registered component on
  //    the SPA). A bare unknown id is a typo → error (the SPA would silently fall back to prose).
  for (const def of agentKinds) {
    const resultView = def.presentation?.resultView
    if (resultView !== undefined && !isValidResultViewId(resultView, knownResultViewIds)) {
      problems.push({
        severity: 'error',
        code: 'unknown_result_view',
        message:
          `Agent kind "${def.kind}" declares resultView "${resultView}", which is neither a known ` +
          `built-in result view nor a namespaced consumer id (<ns>:<name>). Use one of: ` +
          `${[...knownResultViewIds].join(', ')} — or a namespaced id paired with a frontend component.`,
      })
    }
  }

  // 3. Coherence (warn): a kind with postOps that has an agent step which is NOT structured
  //    output likely can't feed those post-ops from `result.custom`. Heuristic, so a warning.
  for (const def of agentKinds) {
    const hasPostOps = (def.postOps?.length ?? 0) > 0
    const declaresStructured =
      def.agent?.output?.kind === 'structured' || registry.structuredOutput(def.kind) !== undefined
    if (hasPostOps && def.agent && !declaresStructured) {
      problems.push({
        severity: 'warn',
        code: 'postops_without_structured_output',
        message:
          `Agent kind "${def.kind}" declares postOps but its agent step has no structured ` +
          `output — postOps that read result.custom will see nothing. Declare structuredOutput ` +
          `(or agent.output.kind: 'structured') if the post-op consumes the agent's JSON.`,
      })
    }
  }

  // 4. Pipeline kinds (only when a built-in catalog is supplied — see option doc).
  if (opts.knownAgentKinds) {
    const known = opts.knownAgentKinds
    for (const pipeline of opts.pipelineRegistry?.registered() ?? []) {
      for (const agentKind of pipeline.agentKinds) {
        const ok =
          known.has(agentKind) ||
          registeredKindIds.has(agentKind) ||
          gateKinds.has(agentKind) ||
          builtInHelperKinds.has(agentKind)
        if (!ok) {
          problems.push({
            severity: 'error',
            code: 'pipeline_unknown_kind',
            message:
              `Pipeline "${pipeline.id}" references agent kind "${agentKind}", which is not a ` +
              `known built-in, a registered kind, or a registered gate.`,
          })
        }
      }
    }
  }

  // 5. Custom task types (only when a task-type registry is supplied). Each registration must
  //    carry a NAMESPACED id (`<ns>:<name>`) and, if set, a well-formed namespaced `formPanel`
  //    id; a `defaultPipelineId` must resolve against the built-in + registered pipeline catalog
  //    (else the created task would silently fall back to the positional default).
  if (opts.taskTypeRegistry) {
    const knownPipelineIds = new Set(seedPipelines(opts.pipelineRegistry).map((p) => p.id))
    for (const taskType of opts.taskTypeRegistry.all()) {
      if (!isNamespacedId(taskType.taskType)) {
        problems.push({
          severity: 'error',
          code: 'task_type_not_namespaced',
          message:
            `Custom task type "${taskType.taskType}" is not a namespaced id (<ns>:<name>, ` +
            `lowercase a-z0-9, dash-separated). A bare id collides with the built-in picklist.`,
        })
      }
      if (taskType.formPanel !== undefined && !isNamespacedId(taskType.formPanel)) {
        problems.push({
          severity: 'error',
          code: 'task_type_form_panel_invalid',
          message:
            `Custom task type "${taskType.taskType}" declares formPanel "${taskType.formPanel}", ` +
            `which is not a namespaced id (<ns>:<name>). Pair it with a frontend component in the ` +
            `taskTypeFormPanels slot under that id.`,
        })
      }
      if (
        taskType.defaultPipelineId !== undefined &&
        !knownPipelineIds.has(taskType.defaultPipelineId)
      ) {
        problems.push({
          severity: 'error',
          code: 'task_type_unknown_pipeline',
          message:
            `Custom task type "${taskType.taskType}" declares defaultPipelineId ` +
            `"${taskType.defaultPipelineId}", which is neither a built-in nor a registered ` +
            `pipeline. Register the pipeline (PipelineRegistry) or fix the id.`,
        })
      }
    }
  }

  return problems
}

/**
 * Validate the registered extensions, throwing an aggregated error on any `error`-severity
 * problem and logging `warn`-severity ones. Call once at facade boot, after every `register*`
 * import side effect + provider wiring, before serving requests.
 */
export function validateRegistrations(opts: ValidateRegistrationsOptions): void {
  const problems = collectRegistrationProblems(opts)
  if (opts.onWarn) {
    for (const w of problems.filter((p) => p.severity === 'warn')) opts.onWarn(w)
  }
  const errors = problems.filter((p) => p.severity === 'error')
  if (errors.length > 0) {
    throw new Error(
      `Invalid extension registrations (${errors.length}):\n` +
        errors.map((e) => `  - [${e.code}] ${e.message}`).join('\n'),
    )
  }
}

// A module-level guard so a per-request facade build (the Worker rebuilds its container per
// request) validates ONCE rather than on every request. Tests that intentionally register
// bogus kinds call `collectRegistrationProblems`/`validateRegistrations` directly instead.
let validated = false

/** Run {@link validateRegistrations} at most once per process. Safe to call from a per-request build. */
export function validateRegistrationsOnce(opts: ValidateRegistrationsOptions): void {
  if (validated) return
  // Flip the guard only AFTER a clean validation. Setting it first would poison the guard on a
  // throw: on the Worker (where this runs inside `fetch` on the first request) a misconfigured
  // deployment would 500 exactly once, then — the module flag now `true` for the isolate's life —
  // serve the broken config silently on every later request. Validating until it passes keeps the
  // failure loud (every request re-throws) until the deployment is fixed, matching the boot intent.
  validateRegistrations(opts)
  validated = true
}

/** Reset the once-guard. Intended for tests that exercise the boot path repeatedly. */
export function resetRegistrationValidationGuard(): void {
  validated = false
}
