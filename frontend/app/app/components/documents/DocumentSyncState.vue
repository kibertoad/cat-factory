<script setup lang="ts">
import { isConnectableSource } from '@cat-factory/contracts'
import type { SourceDocument } from '~/types/domain'
import {
  CHANGE_KEYS,
  GAP_KEYS,
  RENDER_STATUS_KEYS,
} from '~/components/documents/DocumentSyncState.logic'

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
//
// BOTH are rendered WITH THEIR TIME, and that is not decoration. Each is a claim about a moment in
// the history of a page someone else is still editing, and a moment stated without its time is read
// as "now": a confirmation reached an hour ago would otherwise keep showing a green check under
// copy that says the copy is current, which is the precise false confidence this whole surface
// exists to remove. Hence the `long` datetime format (`short` is date-only, so two writes on the
// same day are indistinguishable) on the one side and the verdict's own `checkedAt` on the other.
const props = defineProps<{ doc: SourceDocument }>()

const { t, d } = useI18n()
const documents = useDocumentsStore()
const { present } = usePipelineErrorToast()

/**
 * The source to ask, or null for an origin with nobody to ask. An `upload` was handed to the
 * platform through the API and has no page behind it, so it gets the stamp and no action; the
 * backend refuses the call for the same reason, and narrowing here keeps the SPA from making it.
 */
const askable = computed(() => (isConnectableSource(props.doc.source) ? props.doc.source : null))

const verdict = computed(() => documents.freshnessFor(props.doc.source, props.doc.externalId))
const busy = computed(() => documents.isRefreshing(props.doc.source, props.doc.externalId))

interface Stated {
  tone: 'ok' | 'warn' | 'muted'
  icon: string
  text: string
  /** The revision token, shown only when there IS one to paste back into the source. */
  revision: string
}

/** What the last check concluded, or null when nobody has asked yet. */
const stated = computed<Stated | null>(() => {
  const value = verdict.value?.verdict
  if (!value) return null
  switch (value.status) {
    case 'confirmed':
      // None of the three is a degradation, but they are the whole answer to "did my edit land",
      // and each answers it differently.
      return {
        tone: 'ok',
        icon: 'i-lucide-check',
        text: t(CHANGE_KEYS[value.change]),
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

/**
 * The verdict's own moment, always rendered beside it.
 *
 * A verdict does not expire and is deliberately not made to: expiring it would invent an "unknown"
 * where the rule is that only "nobody has asked" exists. What makes that safe is stating WHEN, so a
 * check reached an hour ago reads as an hour-old check instead of as the current state of a page
 * that has had an hour to move.
 */
const checkedAt = computed(() => {
  const at = verdict.value?.checkedAt
  if (at === undefined) return ''
  return t('documents.freshness.checkedAt', { when: d(new Date(at), 'long') })
})

/**
 * The verdict's detail line: which revision was confirmed, and when it was confirmed.
 *
 * In the hover title rather than the row, which is an 11px line already carrying a stamp, a
 * sentence and a button. That placement is only safe because the visible sentences state what the
 * check FOUND and never when it ran ("Matches the source", not "current as of just now"): a claim
 * about the present tense would still be a claim about the present tense with the timestamp hidden
 * one layer down.
 */
const detail = computed(() =>
  [
    stated.value?.revision
      ? t('documents.freshness.revision', { version: stated.value.revision })
      : '',
    checkedAt.value,
  ]
    .filter(Boolean)
    .join(' · '),
)

/**
 * What became of the design's rendered images, when that is something a person can act on.
 *
 * A THIRD fact beside the two above, and separate for the same reason they are separate from each
 * other: it is about the pictures rather than the text, it is written by the import rather than by
 * a click, and folding it into either would make an absent image read as a stale body. It renders
 * only for the statuses that name a fix, so the common case adds nothing to the line.
 */
const renders = computed(() => {
  const status = props.doc.renderStatus
  const key = status ? RENDER_STATUS_KEYS[status] : null
  return key ? t(key) : ''
})

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
    present(e, 'documents.freshness.refreshFailed')
  }
}
</script>

<template>
  <div class="flex items-center gap-1.5 text-[11px] text-slate-500">
    <span class="truncate">
      {{ t('documents.freshness.updated', { when: d(new Date(props.doc.syncedAt), 'long') }) }}
    </span>
    <span
      v-if="stated"
      class="flex min-w-0 items-center gap-1"
      :class="TONE_CLASS[stated.tone]"
      :title="detail || undefined"
    >
      <UIcon :name="stated.icon" class="h-3 w-3 shrink-0" />
      <span class="truncate">{{ stated.text }}</span>
    </span>
    <span v-if="renders" class="flex min-w-0 items-center gap-1 text-slate-500" :title="renders">
      <UIcon name="i-lucide-image-off" class="h-3 w-3 shrink-0" />
      <span class="truncate">{{ renders }}</span>
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
