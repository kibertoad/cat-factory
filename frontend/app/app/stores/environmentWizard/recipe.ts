import * as v from 'valibot'
import { type ProvisioningSeedDumpCandidate, stackRecipeSchema } from '@cat-factory/contracts'
import type { WizardContext } from './context'

/**
 * The working-recipe editing actions (compose-file / profile toggles, seed-step insertion, raw-JSON
 * replace). Closes over the shared {@link WizardContext}; behaviour is identical to the former
 * in-closure functions (a size-only extraction).
 */
export function createRecipeActions(ctx: WizardContext) {
  const { recipe, composeService } = ctx

  /** Toggle an OS-override / extra compose file into the working recipe's ordered `composeFiles`. */
  function toggleComposeFile(path: string) {
    const files = recipe.value.composeFiles ? [...recipe.value.composeFiles] : []
    const idx = files.indexOf(path)
    if (idx >= 0) files.splice(idx, 1)
    else files.push(path)
    recipe.value = { ...recipe.value, composeFiles: files }
  }

  /** Toggle a `COMPOSE_PROFILES` label into the working recipe. */
  function toggleProfile(profile: string) {
    const profiles = recipe.value.composeProfiles ? [...recipe.value.composeProfiles] : []
    const idx = profiles.indexOf(profile)
    if (idx >= 0) profiles.splice(idx, 1)
    else profiles.push(profile)
    recipe.value = { ...recipe.value, composeProfiles: profiles }
  }

  /**
   * Convert a confirmed seed-dump candidate into a `compose-exec` step that pipes the dump via
   * stdin. The service + command are a best-effort default (the exposed/db service + a `cat`
   * placeholder) the operator refines in the recipe editor — detection can't know the DB client.
   */
  function addSeedStep(candidate: ProvisioningSeedDumpCandidate) {
    const setupSteps = recipe.value.setupSteps ? [...recipe.value.setupSteps] : []
    setupSteps.push({
      kind: 'compose-exec',
      name: `Import seed ${candidate.name}`,
      service: composeService.value || 'db',
      command: ['sh', '-c', 'cat'],
      stdinFile: candidate.path,
    })
    recipe.value = { ...recipe.value, setupSteps }
  }

  /** Replace the working recipe from a raw-JSON edit; returns an error message or null on success. */
  function setRecipeFromJson(text: string): string | null {
    let parsedJson: unknown
    try {
      parsedJson = JSON.parse(text)
    } catch (err) {
      return err instanceof Error ? err.message : 'Invalid JSON'
    }
    const result = v.safeParse(stackRecipeSchema, parsedJson)
    if (!result.success) return result.issues.map((i) => i.message).join('; ')
    recipe.value = result.output
    return null
  }

  return { toggleComposeFile, toggleProfile, addSeedStep, setRecipeFromJson }
}
