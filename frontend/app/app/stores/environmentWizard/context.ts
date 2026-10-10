import type { ComputedRef, Ref } from 'vue'
import type {
  MergedRecipeDraft,
  PreflightResult,
  ProvisioningRecommendation,
  StackRecipe,
} from '@cat-factory/contracts'
import type { useBoardStore } from '~/stores/board'
import type { useExecutionStore } from '~/stores/execution'
import type { useGitHubStore } from '~/stores/github'
import type { useInfraConfigStore } from '~/stores/infraConfig'
import type { usePreflightsStore } from '~/stores/preflights'

/**
 * Shared reactive state + resolved store handles the environment-wizard action factories
 * ({@link import('./flow').createFlowActions}, {@link import('./recipe').createRecipeActions},
 * {@link import('./save').createSaveActions}) close over. Assembled once in the store setup and
 * threaded into each factory so the split actions stay behaviourally identical to the former
 * single-closure store — a size-only extraction following the `board` store idiom.
 */
export interface WizardContext {
  board: ReturnType<typeof useBoardStore>
  github: ReturnType<typeof useGitHubStore>
  infra: ReturnType<typeof useInfraConfigStore>
  execution: ReturnType<typeof useExecutionStore>
  preflights: ReturnType<typeof usePreflightsStore>
  // ---- state ----
  frameId: Ref<string | null>
  detecting: Ref<boolean>
  detectError: Ref<boolean>
  recommendation: Ref<ProvisioningRecommendation | null>
  analysisRequested: Ref<boolean>
  analysisError: Ref<boolean>
  recipe: Ref<StackRecipe>
  composeService: Ref<string>
  preflightRunning: Ref<boolean>
  preflightResults: Ref<PreflightResult[] | null>
  preflightError: Ref<string | null>
  handlerLabel: Ref<string>
  exposedPort: Ref<number>
  saving: Ref<boolean>
  saveError: Ref<string | null>
  saved: Ref<boolean>
  trialing: Ref<boolean>
  trialError: Ref<string | null>
  trialStarted: Ref<boolean>
  // ---- derived the actions read ----
  repoContext: ComputedRef<{ githubId: number; directory?: string | null } | undefined>
  merged: ComputedRef<MergedRecipeDraft | null>
}

/** Drop empty arrays / undefined so the persisted recipe stays minimal and schema-valid
 *  (`composeFiles` etc. are `minLength(1)`, so an empty array would 422). */
export function pruneRecipe(recipe: StackRecipe): StackRecipe {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(recipe)) {
    if (value === undefined || value === null) continue
    if (Array.isArray(value) && value.length === 0) continue
    out[key] = value
  }
  return out as StackRecipe
}

export function cloneRecipe(recipe: StackRecipe): StackRecipe {
  return JSON.parse(JSON.stringify(recipe)) as StackRecipe
}
