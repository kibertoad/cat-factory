<script setup lang="ts">
import { computed } from 'vue'
import type { FindingEvidence } from '@cat-factory/contracts'
import MarkdownProse from '~/components/common/MarkdownProse.vue'
import { QUESTION_STATUS_COLOR, type ReaderQuestion } from '~/utils/research'

// One question and its current answer: status, confidence, the answer itself, the evidence it
// rests on, its caveats, and the later attempts that did not replace it. A `blocked` answer names
// the credential it waited for.

const props = defineProps<{ entry: ReaderQuestion }>()
const { t } = useI18n()

const finding = computed(() => props.entry.folded?.finding)

function evidenceLabel(evidence: FindingEvidence): string {
  switch (evidence.kind) {
    case 'http-exchange':
      return t('research.evidence.httpExchange', { ref: evidence.ref })
    case 'screenshot':
      return t('research.evidence.screenshot', { id: evidence.artifactId })
    case 'url':
      return evidence.url
    case 'repo-path':
      return t('research.evidence.repoPath', { path: evidence.path })
    default:
      return unknownEvidence(evidence)
  }
}

function unknownEvidence(evidence: never): string {
  return JSON.stringify(evidence)
}
</script>

<template>
  <div class="rounded-lg border border-default p-3" data-testid="research-finding">
    <div class="flex items-start gap-2">
      <p class="min-w-0 flex-1 text-sm font-medium text-highlighted">{{ entry.question }}</p>
      <UBadge
        :color="QUESTION_STATUS_COLOR[entry.status]"
        variant="subtle"
        size="sm"
        data-testid="research-finding-status"
      >
        {{ t(`research.status.${entry.status}`) }}
      </UBadge>
    </div>
    <template v-if="finding">
      <p class="mt-1 text-2xs text-dimmed">
        {{ t(`research.confidence.${finding.confidence}`) }}
      </p>
      <MarkdownProse v-if="finding.answer" class="mt-2 text-sm" :text="finding.answer" />
      <p
        v-if="finding.blockedOn"
        class="mt-2 text-xs text-app-warning-400"
        data-testid="research-finding-blocked"
      >
        {{ t('research.blockedOn', { key: finding.blockedOn.credentialKey }) }}
      </p>
      <ul v-if="finding.evidence.length" class="mt-2 space-y-1">
        <li
          v-for="(evidence, i) in finding.evidence"
          :key="i"
          class="flex items-center gap-1.5 text-xs text-muted"
        >
          <UIcon name="i-lucide-paperclip" class="size-3 shrink-0" />
          <ULink v-if="evidence.kind === 'url'" :to="evidence.url" target="_blank" class="truncate">
            {{ evidence.url }}
          </ULink>
          <span v-else class="truncate">{{ evidenceLabel(evidence) }}</span>
        </li>
      </ul>
      <ul v-if="finding.caveats.length" class="mt-2 list-disc space-y-0.5 ps-4 text-xs text-muted">
        <li v-for="(caveat, i) in finding.caveats" :key="i">{{ caveat }}</li>
      </ul>
      <p v-if="entry.folded?.notes.length" class="mt-2 text-2xs text-dimmed">
        {{ t('research.notes', { count: entry.folded.notes.length }) }}
      </p>
    </template>
  </div>
</template>
