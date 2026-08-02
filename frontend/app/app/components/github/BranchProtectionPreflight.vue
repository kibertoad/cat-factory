<script setup lang="ts">
// The branch-protection preflight: for each linked repository, is its DEFAULT branch protected
// on the host?
//
// This is the one control the platform can neither provide nor enforce. An agent run pushes with
// a `Contents: write` credential, and nothing platform-side stops a stolen one from pushing
// straight to `main` — or merging an open pull request through the host's merge API, which needs
// no more permission than the push already had. Branch protection is what covers both, it lives
// on GitHub rather than in this product, and until now nothing in-product said when it was
// missing. See `backend/docs/security-model.md`.
//
// On demand, never on open: each repository costs one or two live GitHub reads, so a panel that
// probed automatically would spend an operator's rate limit every time they glanced at settings.
import { computed, ref } from 'vue'
import type { BranchProtectionReportView, BranchProtectionStateValue } from '@cat-factory/contracts'

const { t } = useI18n()
const api = useApi()
const workspace = useWorkspaceStore()

const report = ref<BranchProtectionReportView | null>(null)
const checking = ref(false)
const failure = ref<string | null>(null)

type Row = BranchProtectionReportView['repos'][number]
type UnknownReason = NonNullable<Row['protection']['reason']>

/** Unprotected first, then unknown, then protected — the order an operator has to act in. */
const RANK: Record<BranchProtectionStateValue, number> = {
  unprotected: 0,
  unknown: 1,
  protected: 2,
}
const rows = computed(() =>
  [...(report.value?.repos ?? [])].sort(
    (a, b) => RANK[a.protection.state] - RANK[b.protection.state],
  ),
)
const exposedCount = computed(
  () => rows.value.filter((r) => r.protection.state === 'unprotected').length,
)

const STATE_STYLE: Record<BranchProtectionStateValue, string> = {
  unprotected: 'text-rose-300',
  unknown: 'text-amber-300',
  protected: 'text-emerald-400',
}

// Exhaustive Records of LITERAL keys, not an assembled `\`…\${state}\`` lookup: the typed-key
// check cannot see a runtime-assembled key, so these are what fail the build when the backend
// adds a state or a reason the SPA has no copy for.
const STATE_LABEL: Record<BranchProtectionStateValue, () => string> = {
  protected: () => t('vcs.branchProtection.state.protected'),
  unprotected: () => t('vcs.branchProtection.state.unprotected'),
  unknown: () => t('vcs.branchProtection.state.unknown'),
}
const UNKNOWN_REASON: Record<UnknownReason, () => string> = {
  branch_not_found: () => t('vcs.branchProtection.unknownReason.branch_not_found'),
  forbidden: () => t('vcs.branchProtection.unknownReason.forbidden'),
  error: () => t('vcs.branchProtection.unknownReason.error'),
}

/**
 * The line under a repository. `unknown` names its CAUSE, and a protected branch whose rule we
 * could not read says so rather than passing as fully verified — the two are different operator
 * situations, and collapsing them is how a report starts lying.
 */
function detailLine(row: Row): string {
  const p = row.protection
  if (p.state === 'unknown') return UNKNOWN_REASON[p.reason ?? 'error']()
  if (p.state === 'unprotected') return t('vcs.branchProtection.unprotectedHint')
  if (p.detailUnavailable) return t('vcs.branchProtection.detailUnavailable')
  if (!p.detail) return ''
  return p.detail.requiresPullRequest
    ? t('vcs.branchProtection.requiresPr', {
        reviews: p.detail.requiredApprovingReviewCount,
        checks: p.detail.requiredStatusChecks.length,
      })
    : t('vcs.branchProtection.noPrRequired')
}

async function check() {
  const workspaceId = workspace.workspaceId
  if (!workspaceId) return
  checking.value = true
  failure.value = null
  try {
    report.value = await api.checkGitHubBranchProtection(workspaceId)
  } catch (e) {
    failure.value = e instanceof Error ? e.message : String(e)
  } finally {
    checking.value = false
  }
}
</script>

<template>
  <section class="space-y-2" data-testid="branch-protection-preflight">
    <h3 class="text-sm font-semibold text-slate-200">{{ t('vcs.branchProtection.heading') }}</h3>
    <p class="text-[11px] text-slate-400">{{ t('vcs.branchProtection.body') }}</p>

    <UButton
      color="neutral"
      variant="soft"
      size="xs"
      icon="i-lucide-shield-check"
      :loading="checking"
      data-testid="branch-protection-check"
      @click="check()"
    >
      {{ t('vcs.branchProtection.check') }}
    </UButton>

    <p v-if="failure" class="text-xs text-rose-400">{{ failure }}</p>

    <!-- The provider cannot answer this at all. Said explicitly, because an empty list here
         would otherwise read exactly like a clean bill of health. -->
    <p
      v-else-if="report && report.capability === 'unavailable'"
      class="text-xs text-amber-300"
      data-testid="branch-protection-unavailable"
    >
      {{ t('vcs.branchProtection.unavailable') }}
    </p>

    <template v-else-if="report">
      <p
        class="text-xs"
        :class="exposedCount ? 'text-rose-300' : 'text-emerald-400'"
        data-testid="branch-protection-summary"
      >
        {{
          exposedCount
            ? t('vcs.branchProtection.exposed', { count: exposedCount }, exposedCount)
            : t('vcs.branchProtection.allProtected')
        }}
      </p>

      <ul class="space-y-1">
        <li
          v-for="row in rows"
          :key="row.repoGithubId"
          class="rounded-md border border-slate-800 bg-slate-900/40 px-2 py-1.5"
        >
          <div class="flex items-baseline justify-between gap-2">
            <span class="font-mono text-xs text-slate-300">{{ row.owner }}/{{ row.name }}</span>
            <span class="text-[11px]" :class="STATE_STYLE[row.protection.state]">
              {{ STATE_LABEL[row.protection.state]() }}
            </span>
          </div>
          <p class="text-[10px] text-slate-500">
            {{ row.defaultBranch }}<span v-if="detailLine(row)"> — {{ detailLine(row) }}</span>
          </p>
        </li>
      </ul>

      <!-- A cap that truncated silently would read as "these are all your repositories", which
           on a security report is the same failure as calling an unprobed repo protected. -->
      <p v-if="report.omittedRepos > 0" class="text-[11px] text-amber-300">
        {{ t('vcs.branchProtection.omitted', { count: report.omittedRepos }, report.omittedRepos) }}
      </p>
    </template>
  </section>
</template>
