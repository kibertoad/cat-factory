import { apiErrorEnvelope } from '~/composables/api/errors'
import { useWorkspaceStore } from '~/stores/workspace'
import type { WizardContext } from './context'
import { pruneRecipe } from './context'

/**
 * The preflight / persist / trial-provision actions — the tail of the wizard. Closes over the
 * shared {@link WizardContext}; behaviour is identical to the former in-closure functions (a
 * size-only extraction).
 */
export function createSaveActions(ctx: WizardContext) {
  const {
    board,
    infra,
    preflights,
    frameId,
    recommendation,
    recipe,
    composeService,
    preflightRunning,
    preflightResults,
    preflightError,
    handlerLabel,
    exposedPort,
    saving,
    saveError,
    saved,
    trialing,
    trialError,
    trialStarted,
  } = ctx

  /** Run the working recipe's declared preflight checks (host-bound; degrades on a non-local facade). */
  async function runPreflight() {
    preflightRunning.value = true
    preflightError.value = null
    try {
      preflightResults.value = await preflights.run(recipe.value.prerequisites ?? [])
    } catch (err) {
      // A 503 is handled inside `preflights.run` (degraded note); anything else is a real failure
      // that must be shown rather than swallowed into an unhandled rejection.
      preflightError.value =
        apiErrorEnvelope(err)?.message ?? (err instanceof Error ? err.message : String(err))
    } finally {
      preflightRunning.value = false
    }
  }

  /**
   * Persist the confirmed config: register the workspace's `docker-compose` handler (so the Deployer
   * can provision it) AND write the recipe onto the service frame's provisioning. The handler carries
   * only the daemon "how" (the exposed service + port); the recipe is the per-service "what/where".
   */
  async function save() {
    const id = frameId.value
    const service = composeService.value.trim()
    if (!id || !service) {
      saveError.value = 'A frame and an exposed compose service are required.'
      return
    }
    // `exposedPort` is a `v-model.number` field, which yields '' (not a number) when cleared. Guard
    // here so an empty/out-of-range port can't reach the handler manifest.
    const port = Number(exposedPort.value)
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      saveError.value = 'Enter a valid exposed port (1-65535).'
      return
    }
    saving.value = true
    saveError.value = null
    const pruned = pruneRecipe(recipe.value)
    const build = recommendation.value?.provisioning.composeBuild === true
    const allowHostCommands = (pruned.setupSteps ?? []).some((s) => s.kind === 'host-command')
    try {
      await infra.registerHandler({
        provisionType: 'docker-compose',
        config: {
          engine: 'local-docker',
          manifest: {
            providerId: 'compose',
            label: handlerLabel.value.trim() || 'Docker Compose',
            baseUrl: 'http://localhost',
            auth: { type: 'none' },
            provision: { method: 'POST', pathTemplate: '' },
            response: {},
            providerConfig: {
              service,
              port,
              ...(build ? { build: true } : {}),
              ...(allowHostCommands ? { allowHostCommands: true } : {}),
            },
          },
        },
        secrets: {},
      })
      await board.updateBlock(id, {
        provisioning: {
          type: 'docker-compose',
          ...(pruned.composeFiles?.[0] ? { composePath: pruned.composeFiles[0] } : {}),
          ...(build ? { composeBuild: true } : {}),
          recipe: pruned,
        },
      })
      saved.value = true
    } catch (err) {
      saveError.value =
        apiErrorEnvelope(err)?.message ?? (err instanceof Error ? err.message : String(err))
    } finally {
      saving.value = false
    }
  }

  /** Optional trial: provision the just-saved config for the frame (local-only; live logs shown). */
  async function trialProvision() {
    const id = frameId.value
    if (!id || !saved.value) return
    trialing.value = true
    trialError.value = null
    try {
      const api = useApi()
      const ws = useWorkspaceStore()
      await api.provisionEnvironment(ws.requireId(), { blockId: id })
      trialStarted.value = true
    } catch (err) {
      trialError.value =
        apiErrorEnvelope(err)?.message ?? (err instanceof Error ? err.message : String(err))
    } finally {
      trialing.value = false
    }
  }

  return { runPreflight, save, trialProvision }
}
