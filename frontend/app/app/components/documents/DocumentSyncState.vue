<script setup lang="ts">
import { isConnectableSource } from '@cat-factory/contracts'
import type { DocumentFreshnessGap, SourceDocument } from '~/types/domain'

// When a stored document was last written, and a way to ask its source whether that is still the
// current revision.
//
// A source-backed document is a PROJECTION of a page someone else keeps editing, and until the
// dispatch-time refresh landed nothing ever looked at the source again. Runs now re-confirm on
// every dispatch, but the person deciding whether to START one still had no way to see it: the
// board showed a title and an excerpt frozen at import, so "is the frame I just edited the one the
// agents will read" was unanswerable without opening Figma and comparing by eye.
//
// TWO facts, deliberately rendered as two, because they answer different questions and one is not
// the other's proxy:
//
//   - `syncedAt` is when the BODY was last written. It is on every row, costs nothing, and moves
//     only when a fetch actually changed something.
//   - the freshness verdict is what the source said when someone last ASKED. It exists only after
//     a click, because confirming costs a round trip per document and listing a board's imported
//     pages must not spend one each.
//
// So an absent verdict means "nobody has asked", never "unknown", and a row that was refreshed and
// found UNCHANGED still shows its old `syncedAt` beside a confirmation: the body genuinely was not
// rewritten, and moving the stamp would claim a write that never happened.
const props = defineProps<{ doc: SourceDocument }>()

const { t, d } = useI18n()
const documents = useDocumentsStore()
const toast = useToast()

/**
 * The source to ask, or null for an origin with nobody to ask. An `upload` was handed to the
 * platform through the API and has no page behind it, so it gets the stamp and no action; the
 * backend refuses the call for the same reason, and narrowing here keeps the SPA from making it.
 */
const askable = computed(() => (isConnectableSource(props.doc.source) ? props.doc.source : null))

const verdict = computed(() => documents.freshnessFor(props.doc.source, props.doc.externalId))
const busy = computed(() => documents.isRefreshing(props.doc.source, props.doc.externalId))

/**
 * One FULL sentence per gap rather than a shared "not confirmed: {reason}" frame, because each of
 * these asks for a different fix and a clause spliced into a sentence is what breaks first in a
 * language whose word order is not English's. Keyed verbatim by the contracts vocabulary, so
 * adding a gap fails to compile here rather than rendering an empty line.
 */
const GAP_KEYS = {
  not_connected: 'documents.freshness.gap.not_connected',
  credentials_unreadable: 'documents.freshness.gap.credentials_unreadable',
  unversioned: 'documents.freshness.gap.unversioned',
  source_unreachable: 'documents.freshness.gap.source_unreachable',
} as const satisfies Record<DocumentFreshnessGap, string>

interface Stated {
  tone: 'ok' | 'warn' | 'muted'
  icon: string
  text: string
  /** The revision token, shown only when there IS one to paste back into the source. */
  revision: string
}

/** What the last check concluded, or null when nobody has asked yet. */
const stated = computed<Stated | null>(() => {
  const value = verdict.value
  if (!value) return null
  switch (value.status) {
    case 'confirmed':
      // `reimported` is not a degradation either way, but the distinction is the whole answer to
      // "did my edit land": one says the board just pulled it, the other that there was nothing to
      // pull.
      return {
        tone: 'ok',
        icon: 'i-lucide-check',
        text: value.reimported
          ? t('documents.freshness.reimported')
          : t('documents.freshness.unchanged'),
        revision: value.version,
      }
    case 'unconfirmed':
      return {
        tone: 'warn',
        icon: 'i-lucide-triangle-alert',
        text: t(GAP_KEYS[value.reason]),
        revision: '',
      }
    case 'not-applicable':
      // Reachable for a connectable source this deployment wired no provider for. Stating it beats
      // rendering nothing after a click, which reads as an action that silently failed.
      return {
        tone: 'muted',
        icon: 'i-lucide-minus',
        text: t('documents.freshness.notApplicable'),
        revision: '',
      }
    default:
      return unstatable(value)
  }
})

/** Compile-time totality over the verdict union: adding a status fails the build here. */
function unstatable(_value: never): null {
  return null
}

const TONE_CLASS: Record<Stated['tone'], string> = {
  ok: 'text-emerald-400',
  warn: 'text-amber-400',
  muted: 'text-slate-500',
}

async function refresh() {
  const source = askable.value
  if (!source || busy.value) return
  try {
    await documents.refresh(source, props.doc.externalId)
  } catch (e) {
    toast.add({
      title: t('documents.freshness.refreshFailed'),
      description: e instanceof Error ? e.message : String(e),
      icon: 'i-lucide-triangle-alert',
      color: 'error',
    })
  }
}
</script>

<template>
  <div class="flex items-center gap-1.5 text-[11px] text-slate-500">
    <span class="truncate">
      {{ t('documents.freshness.updated', { when: d(new Date(props.doc.syncedAt), 'short') }) }}
    </span>
    <span
      v-if="stated"
      class="flex min-w-0 items-center gap-1"
      :class="TONE_CLASS[stated.tone]"
      :title="
        stated.revision
          ? t('documents.freshness.revision', { version: stated.revision })
          : undefined
      "
    >
      <UIcon :name="stated.icon" class="h-3 w-3 shrink-0" />
      <span class="truncate">{{ stated.text }}</span>
    </span>
    <UButton
      v-if="askable"
      color="neutral"
      variant="ghost"
      size="xs"
      icon="i-lucide-refresh-cw"
      :loading="busy"
      :aria-label="t('documents.freshness.refresh')"
      :title="t('documents.freshness.refresh')"
      class="ml-auto shrink-0"
      @click="refresh"
    />
  </div>
</template>
