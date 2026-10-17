import { computed } from 'vue'
import { githubPatCheckSource } from '@cat-factory/contracts'
import type { GitHubPatKind, InfraSetupArea } from '~/types/domain'
import { githubPatRemintUrl } from '~/utils/vcs'

/**
 * Where each setup gap is fixed: the ONE map the setup banners, the setup checklist and the
 * run-start conflict toasts all open through, so "the row opens what its banner opens" holds
 * because there is one place that says it, never two copies kept in step by hand.
 *
 * Keyed by `InfraSetupArea` for the infrastructure, the vocabulary the server reports in, plus the
 * model and source-control remedies, which have no area of their own.
 */
export function useSetupRemedies() {
  const ui = useUiStore()
  const auth = useAuthStore()
  const github = useGitHubStore()

  const INFRA: Record<InfraSetupArea, () => void> = {
    agentExecutor: () => ui.openProviderConnection('runner-pool'),
    ephemeralEnvironments: () => ui.openProviderConnection('environment'),
    binaryStorage: () => ui.openContentStorageSettings(),
  }

  /** Open the screen that configures an infrastructure area. */
  function openInfraArea(area: InfraSetupArea) {
    INFRA[area]()
  }

  /**
   * A Deployer's service environment config is incomplete: that service's own config, the compose
   * wizard for docker-compose and the service inspector otherwise. Without the frame, the
   * workspace's test-environment settings.
   */
  function openServiceEnvironment(frameId?: string, provisionType?: string) {
    if (frameId && provisionType === 'docker-compose') ui.openEnvironmentSetup(frameId)
    else if (frameId) ui.select(frameId)
    else openInfraArea('ephemeralEnvironments')
  }

  /** No usable model: the AI onboarding dialog. */
  function openModelSetup() {
    ui.openAiProviderSetup()
  }

  /** Usable models, but the default preset names one that is not: the preset-mismatch dialog. */
  function openPresetMismatch() {
    ui.openAiPresetMismatch()
  }

  /** Local mode with no token: GitHub's token page, scopes preselected. Null outside that case. */
  const patSetupUrl = computed(() => auth.localMode?.githubPatSetupUrl ?? null)

  /**
   * The token page for a token GitHub rejected or under-scoped. A rejected token was never
   * classified, so it falls back to `unknown`, which lands on the classic form, the only one
   * GitHub lets us pre-fill.
   */
  const patReport = computed(() =>
    github.patCheck?.state === 'checked' ? github.patCheck.report : undefined,
  )
  /** The token's kind, which picks the form. `unknown` for a token GitHub rejected outright. */
  const patKind = computed<GitHubPatKind>(() => patReport.value?.kind ?? 'unknown')
  const patRemintUrl = computed(() =>
    githubPatRemintUrl(patKind.value, patReport.value?.webUrl ?? github.connection?.webUrl),
  )

  /**
   * Whose token that is: the deployment's (replaced by whoever runs it) or the person's own
   * (replaced in their settings). Read off the check, which carries it in every state it reports.
   */
  const patSource = computed(() => (github.patCheck ? githubPatCheckSource(github.patCheck) : null))

  return {
    openInfraArea,
    openServiceEnvironment,
    openModelSetup,
    openPresetMismatch,
    patSetupUrl,
    patKind,
    patRemintUrl,
    patSource,
  }
}
