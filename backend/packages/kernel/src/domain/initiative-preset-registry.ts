import type {
  InitiativePlanDraft,
  InitiativePresetDescriptor,
  InitiativePresetInputs,
} from '@cat-factory/contracts'
import type { AgentKind } from './types.js'
import type { RepoFiles } from '../ports/repo-files.js'
import { INITIATIVE_PIPELINE_ID } from './seed.js'

// Installation-level extension point for initiative PRESETS, mirroring the pipeline / gate
// registry seams (module-global, replace-by-id, registered as a startup import side effect).
// A preset bundles a create-time FORM (its descriptor, rendered generically by the SPA), a
// planning-pipeline binding, execution/fragment/review defaults, and CODE HOOKS a data-only
// registry can't express:
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
 * hooks, so it is always available even after {@link clearRegisteredInitiativePresets}.
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

// Process-wide registry, mirroring the pipeline / gate registry seams. Registration is a
// startup import side effect, read when the create/planning flow + the snapshot builder resolve
// presets. A preset registered AFTER those have run is invisible — register at startup.
const registry = new Map<string, InitiativePresetRegistration>()

/**
 * Register a custom initiative preset. A registration whose id matches an earlier one (or the
 * built-in `preset_generic`) replaces it, so a deployment can both add new presets and customize
 * the generic one.
 */
export function registerInitiativePreset(registration: InitiativePresetRegistration): void {
  registry.set(registration.descriptor.id, registration)
}

/** Register several initiative presets at once. */
export function registerInitiativePresets(
  registrations: Iterable<InitiativePresetRegistration>,
): void {
  for (const registration of registrations) registerInitiativePreset(registration)
}

/**
 * Resolve one preset by id, or `undefined` when unknown. The built-in `preset_generic` is always
 * resolvable (unless a registration overrode it), even with an otherwise-empty registry.
 */
export function getInitiativePreset(id: string): InitiativePresetRegistration | undefined {
  const registered = registry.get(id)
  if (registered) return registered
  return id === GENERIC_INITIATIVE_PRESET_ID ? GENERIC_INITIATIVE_PRESET : undefined
}

/**
 * All presets (registration order), with the built-in `preset_generic` FIRST unless a
 * registration replaced it. This is what the snapshot builder serialises for the SPA picker.
 */
export function allInitiativePresets(): InitiativePresetRegistration[] {
  const registered = [...registry.values()]
  if (registry.has(GENERIC_INITIATIVE_PRESET_ID)) return registered
  return [GENERIC_INITIATIVE_PRESET, ...registered]
}

/** The serialisable descriptors of {@link allInitiativePresets}, with `probe` derived from `detect`. */
export function initiativePresetDescriptors(): InitiativePresetDescriptor[] {
  return allInitiativePresets().map((p) => ({ ...p.descriptor, probe: !!p.detect }))
}

/** Drop all registered presets (the built-in `preset_generic` survives). Intended for tests. */
export function clearRegisteredInitiativePresets(): void {
  registry.clear()
}
