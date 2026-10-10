import type {
  InitiativePlanDraft,
  InitiativePresetDescriptor,
  InitiativePresetInputs,
} from '@cat-factory/contracts'
import type { AgentKind } from './types.js'
import type { RepoFiles } from '../ports/repo-files.js'
import { INITIATIVE_PIPELINE_ID } from './seed.js'

// Installation-level extension point for initiative PRESETS, mirroring the app-owned agent-kind
// registry (`AgentKindRegistry` / `defaultAgentKindRegistry`). A preset bundles a create-time
// FORM (its descriptor, rendered generically by the SPA), a planning-pipeline binding,
// execution/fragment/review defaults, and CODE HOOKS a data-only registry can't express:
//   - `detect`         — a deterministic, bounded, best-effort repo probe that PREFILLS the
//                        form (over the checkout-free {@link RepoFiles} port). Never throws.
//   - `seedPlan`       — a PURE post-processor/validator of the planner's draft at ingest
//                        (enforce phase shape, stamp per-item `spawn` decoration, …).
//   - `promptAdditions`— per-agent-kind planning-prompt steering text (DATA, folded into the
//                        planning steps' prompts; kept off the wire descriptor).
// Because a preset carries code + can steer agents + read repos, it is exactly as trusted as
// a custom agent kind: presets are code-carrying backend packages (the
// `backend/internal/example-custom-agent` trust model). See
// `docs/initiatives/initiative-presets-and-docs-refresh.md`.
//
// The composition root news ONE instance per app (`defaultInitiativePresetRegistry()`, in
// `@cat-factory/agents` — it preloads the built-ins), threads it through `CoreDependencies`, and
// every create/planning/snapshot read resolves it from there — so there is no module-global
// `Map`, no `clear*()` test cruft, and no external-adapter module-identity gotcha: a deployment
// registers extra presets by reference (`registry.register(registration)`) on the instance the
// facade injects.

/** The registration bundle for one initiative preset (descriptor + optional code hooks). */
export interface InitiativePresetRegistration {
  /** The serialisable, SPA-facing descriptor (form + pipeline binding + defaults). */
  descriptor: InitiativePresetDescriptor
  /**
   * Deterministic, bounded, best-effort probe that prefills the form from the target repo.
   * Runs on the backend over the checkout-free {@link RepoFiles} port. MUST be bounded (a hard
   * `listDirectory` budget) and MUST NOT throw — an unwired GitHub / a failure yields `{}` and
   * the form falls back to the descriptor defaults. Omitted ⇒ no probe (descriptor `probe` is
   * false and the SPA never calls the probe endpoint for this preset).
   */
  detect?(repo: RepoFiles): Promise<InitiativePresetInputs>
  /**
   * Pure post-processor/validator of the planner's draft, run at ingest BEFORE `applyPlanDraft`.
   * Receives the frozen `presetInputs` so it can enforce the preset's plan shape (a Foundations
   * phase, bounded item granularity) and stamp each item's `spawn` decoration. Must be pure
   * (no I/O) and total. Omitted ⇒ the draft is applied unchanged.
   */
  seedPlan?(draft: InitiativePlanDraft, inputs: InitiativePresetInputs): InitiativePlanDraft
  /** Per-agent-kind planning-prompt steering text, folded into the planning steps' prompts. */
  promptAdditions?: Partial<Record<AgentKind, string>>
}

/** The built-in generic preset's id — the default the SPA picker selects. */
export const GENERIC_INITIATIVE_PRESET_ID = 'preset_generic'

/**
 * The built-in generic preset: the strangler wrapper that makes the existing generic initiative
 * "just the default preset". Empty form, the interviewer-driven `pl_initiative` pipeline, human
 * review on — i.e. exactly today's behaviour. Nothing in the planning/loop path branches on
 * "has preset"; a preset only ever ADDS context, so the generic one adds none. It has no code
 * hooks, so every {@link InitiativePresetRegistry} resolves it even with an otherwise-empty
 * registry.
 */
const GENERIC_INITIATIVE_PRESET: InitiativePresetRegistration = {
  descriptor: {
    id: GENERIC_INITIATIVE_PRESET_ID,
    presentation: {
      label: 'Custom initiative',
      icon: 'i-lucide-git-branch-plus',
      color: '#6366f1',
      description:
        'Plan an open-ended body of work through a guided interview, then execute it as a loop of tasks.',
    },
    fields: [],
    planningPipelineId: INITIATIVE_PIPELINE_ID,
    interview: 'full',
    humanReviewDefault: true,
    defaultFragmentIds: [],
  },
}

/**
 * App-owned registry of initiative presets, mirroring {@link AgentKindRegistry}. The composition
 * root news ONE instance per app (`defaultInitiativePresetRegistry()` in `@cat-factory/agents`,
 * which preloads the built-in docs-refresh / tech-migration presets), threads it through
 * `CoreDependencies`, and re-exposes it on `Core` for the HTTP layer's snapshot projection + the
 * preset probe. The built-in generic preset is baked in (always resolvable) so an otherwise-empty
 * registry still serves the default initiative; a deployment adds its own presets by reference
 * (`register` / `registerAll`) on the instance the facade injects.
 */
export class InitiativePresetRegistry {
  private readonly registry = new Map<string, InitiativePresetRegistration>()

  /**
   * Register a custom initiative preset. A registration whose id matches an earlier one (or the
   * built-in `preset_generic`) replaces it, so a deployment can both add new presets and customize
   * the generic one.
   */
  register(registration: InitiativePresetRegistration): void {
    this.registry.set(registration.descriptor.id, registration)
  }

  /** Register several initiative presets at once. */
  registerAll(registrations: Iterable<InitiativePresetRegistration>): void {
    for (const registration of registrations) this.register(registration)
  }

  /**
   * Resolve one preset by id, or `undefined` when unknown. The built-in `preset_generic` is always
   * resolvable (unless a registration overrode it), even with an otherwise-empty registry.
   */
  get(id: string): InitiativePresetRegistration | undefined {
    const registered = this.registry.get(id)
    if (registered) return registered
    return id === GENERIC_INITIATIVE_PRESET_ID ? GENERIC_INITIATIVE_PRESET : undefined
  }

  /**
   * All presets (registration order), with the built-in `preset_generic` FIRST unless a
   * registration replaced it. This is what the snapshot builder serialises for the SPA picker.
   */
  all(): InitiativePresetRegistration[] {
    const registered = [...this.registry.values()]
    if (this.registry.has(GENERIC_INITIATIVE_PRESET_ID)) return registered
    return [GENERIC_INITIATIVE_PRESET, ...registered]
  }

  /** The serialisable descriptors of {@link all}, with `probe` derived from `detect`. */
  descriptors(): InitiativePresetDescriptor[] {
    return this.all().map((p) => ({ ...p.descriptor, probe: !!p.detect }))
  }
}
