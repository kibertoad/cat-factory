<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  GITHUB_PAT_FINE_GRAINED_PERMISSIONS,
  githubPatCheckNeedsAttention,
  githubPatCheckSource,
  missingGitHubPatCapabilities,
} from '@cat-factory/contracts'
import type { GitHubPatCapability, GitHubPatKind } from '~/types/domain'
import { githubPatRemintUrl } from '~/utils/vcs'

// The token a run would authenticate with cannot do what the pipeline needs.
//
// This is the board-load half of a warning the backend already logs at boot in local mode: a
// developer's terminal is easy to miss, and on a HOSTED deployment there is no terminal at all
// for the case this also covers, where the run initiator's own stored token outranks the App
// installation. Either way the alternative to saying it here is saying it eight steps into a
// pipeline as a 403 out of a container, after the run has spent money.
//
// It raises on ESTABLISHED blocking gaps only (`githubPatCheckNeedsAttention`). An unreachable
// GitHub, an advisory-only finding and an unknowable fine-grained permission each render
// nothing over the board, because none of them is something the reader can act on right now and
// a banner that appears when nothing is wrong is one people learn to dismiss unread.
//
// Positioning/stacking is owned by `BoardTopOverlays`; this renders only its card.

const { t } = useI18n()
const github = useGitHubStore()

const dismissed = ref(false)
const check = computed(() => github.patCheck)
const show = computed(
  () => !dismissed.value && check.value !== null && githubPatCheckNeedsAttention(check.value),
)

/** The report, when the check produced one. Absent for a token GitHub rejected outright. */
const report = computed(() => (check.value?.state === 'checked' ? check.value.report : undefined))

/**
 * Which claim the card is making. `rejected` is the strictly worse problem (the token does not
 * authenticate at all), so it gets its own copy rather than being folded into "some capability
 * is missing" — every capability would read as missing, which describes the symptom and not the
 * cause.
 */
const claim = computed<'rejected' | 'underscoped'>(() =>
  check.value?.state === 'token_rejected' ? 'rejected' : 'underscoped',
)

const missing = computed<GitHubPatCapability[]>(() =>
  report.value ? missingGitHubPatCapabilities(report.value).blocking : [],
)
/**
 * Established gaps that do NOT stop a pipeline, listed inside the card but never the reason it
 * opened. Today that is `workflows`: worth fixing while you are on the token page, not worth
 * interrupting a board for on its own.
 */
const advisory = computed<GitHubPatCapability[]>(() =>
  report.value ? missingGitHubPatCapabilities(report.value).advisory : [],
)

const CAPABILITY_KEYS: Record<GitHubPatCapability, string> = {
  push: 'layout.githubPatPermissionsBanner.capability.push',
  pullRequests: 'layout.githubPatPermissionsBanner.capability.pullRequests',
  workflows: 'layout.githubPatPermissionsBanner.capability.workflows',
}
function capabilityLabel(capability: GitHubPatCapability): string {
  return t(CAPABILITY_KEYS[capability])
}

/**
 * The kind carried over to the re-mint link. A rejected token was never classified, so it falls
 * back to `unknown` — which lands on the classic form, the only one GitHub lets us pre-fill.
 */
const kind = computed<GitHubPatKind>(() => report.value?.kind ?? 'unknown')
const remintUrl = computed(() =>
  githubPatRemintUrl(kind.value, report.value?.webUrl ?? github.connection?.webUrl),
)

/**
 * Who has to act. A deployment token is replaced by whoever runs the deployment (local mode:
 * the developer at the terminal); an initiator token belongs to the signed-in user and is
 * replaced in their own settings. Sending one to the other's remedy is worse than saying
 * nothing, which is why the source rides the wire rather than being guessed from the shape.
 *
 * Read through the contract's own accessor rather than off `report`, because a REJECTED token
 * produces no report and every state this banner renders carries a source. Deriving it from the
 * report alone left the rejected case falling through to whichever branch the ternary ended on,
 * which told a local developer whose deployment token had expired to replace it in their
 * personal settings: the exact misrouting the wire field exists to prevent.
 */
const sourceKey = computed(() =>
  check.value && githubPatCheckSource(check.value) === 'deployment'
    ? 'layout.githubPatPermissionsBanner.sourceDeployment'
    : 'layout.githubPatPermissionsBanner.sourceInitiator',
)

/** The fine-grained form takes no prefill, so the permissions have to be named as prose. */
const fineGrainedPermissions = GITHUB_PAT_FINE_GRAINED_PERMISSIONS.join(', ')
</script>

<template>
  <Transition name="fade">
    <div v-if="show" class="pointer-events-auto w-full max-w-3xl">
      <div
        class="w-full max-w-3xl rounded-2xl border-2 border-red-500/70 bg-red-950/95 p-5 shadow-2xl backdrop-blur"
        role="alert"
        data-testid="github-pat-permissions-banner"
      >
        <div class="flex items-start gap-4">
          <UIcon name="i-lucide-shield-alert" class="mt-0.5 h-9 w-9 shrink-0 text-red-400" />
          <div class="min-w-0 flex-1">
            <div class="flex items-start justify-between gap-3">
              <h2 class="text-lg font-semibold text-red-100">
                {{
                  claim === 'rejected'
                    ? t('layout.githubPatPermissionsBanner.rejectedTitle')
                    : t('layout.githubPatPermissionsBanner.title')
                }}
              </h2>
              <UButton
                color="neutral"
                variant="ghost"
                size="xs"
                icon="i-lucide-x"
                :aria-label="t('common.close')"
                @click="
                  () => {
                    dismissed = true
                  }
                "
              />
            </div>

            <p class="mt-1 text-sm text-red-200/90">
              {{
                claim === 'rejected'
                  ? t('layout.githubPatPermissionsBanner.rejectedBody')
                  : t('layout.githubPatPermissionsBanner.body')
              }}
            </p>

            <!-- The established gaps, named one by one. A bare "permissions are missing" leaves
                 the reader to guess which box to tick on a form with dozens. -->
            <p v-if="missing.length" class="mt-3 text-sm text-red-100">
              <span class="font-medium">{{ t('layout.githubPatPermissionsBanner.missing') }}</span>
              {{ missing.map(capabilityLabel).join(', ') }}
            </p>
            <p v-if="advisory.length" class="mt-1 text-xs text-red-200/80">
              {{
                t('layout.githubPatPermissionsBanner.alsoMissing', {
                  capabilities: advisory.map(capabilityLabel).join(', '),
                })
              }}
            </p>

            <!-- For a fine-grained token, WHICH repositories it was not granted is the whole
                 remedy: the permission list is right and the repository selection is not. -->
            <p v-if="report && report.deniedRepos.length" class="mt-1 text-xs text-red-200/80">
              {{
                t('layout.githubPatPermissionsBanner.deniedRepos', {
                  repos: report.deniedRepos.join(', '),
                })
              }}
            </p>

            <p class="mt-2 text-xs text-red-200/80">{{ t(sourceKey) }}</p>

            <div class="mt-4">
              <UButton
                :to="remintUrl"
                target="_blank"
                rel="noopener noreferrer"
                color="error"
                variant="solid"
                icon="i-lucide-external-link"
                trailing
              >
                {{
                  kind === 'fine_grained'
                    ? t('layout.githubPatPermissionsBanner.createFineGrained')
                    : t('layout.githubPatPermissionsBanner.createClassic')
                }}
              </UButton>
              <!-- The classic form arrives with the scopes ticked; the fine-grained one accepts
                   no prefill at all, so its permissions are spelled out. Saying so is the point:
                   a link that silently arrived with nothing selected reads as "already done for
                   you", which is how the missing permission got there in the first place. -->
              <p class="mt-2 text-xs text-red-300/70">
                {{
                  kind === 'fine_grained'
                    ? t('layout.githubPatPermissionsBanner.fineGrainedHint', {
                        permissions: fineGrainedPermissions,
                      })
                    : t('layout.githubPatPermissionsBanner.classicHint')
                }}
              </p>
              <!-- A fine-grained verdict is a SAMPLE of the linked repositories. Declaring the
                   remainder keeps a clean-looking list from reading as a guarantee. -->
              <p v-if="report && report.unprobedRepoCount > 0" class="mt-1 text-xs text-red-300/60">
                {{
                  t('layout.githubPatPermissionsBanner.sampled', {
                    checked: report.probedRepos.length,
                    remaining: report.unprobedRepoCount,
                  })
                }}
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
