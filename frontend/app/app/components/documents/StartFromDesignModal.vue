<script setup lang="ts">
// Start a task from a design link: paste a Figma/Zeplin URL on a service frame, and the resolved
// reference is staged onto the add-task form as context. One affordance, three steps that used to
// be four separate surfaces (Integrations hub → import modal → board → add task → attach).
//
// Three rules this surface exists to hold, each of which the obvious version gets wrong.
//
//  - It resolves the reference BEFORE anything is created, through the same
//    `POST /document-sources/:source/resolve-ref` the attach picker uses, so a share link's title
//    segment and tracking params are trimmed where the person who pasted them can still see it,
//    and a link the source cannot read is a correction rather than a toast over a task that
//    already exists without its design.
//  - It only asks the CONNECTED DESIGN sources, and it asks them in claim-confidence order
//    (host-pinned first), because a host-blind prose parser will happily claim a Figma URL whose
//    file key carries a UUID-shaped run. `connectedDesignSources` is already in registry order
//    and every design source is host-pinned, so the order is the store's.
//  - A WIDENED reference is stated separately from a trimmed one. Figma's own Copy link emits a
//    complex instance id for any component instance, which the parser cannot read, so it falls
//    back to the whole file: "I attached this frame" and "I attached the entire design" otherwise
//    render identically. For a designer that widening IS the defect, not a detail.
import { refRowFor, classifyRefFailure, type RefState } from './ContextDocumentPicker.logic'
import type { DocumentSourceKind, ResolvedDocumentRef } from '~/types/domain'

const { t } = useI18n()
const ui = useUiStore()
const documents = useDocumentsStore()

const open = computed({
  get: () => ui.startFromDesign !== null,
  set: (v: boolean) => {
    if (!v) ui.closeStartFromDesign()
  },
})

const pasted = ref('')
const state = ref<RefState>({ status: 'none' })
/** The source that claimed the paste, held beside the verdict so the staged item names it. */
const claimant = ref<DocumentSourceKind | null>(null)
/**
 * The exact text {@link state} is the verdict FOR, so the same text is never re-resolved.
 *
 * This is what keeps Continue clickable. The input resolves on blur, and clicking Continue blurs
 * it, so a person who resolved with Enter and then reached for the button re-entered `resolve()`
 * on mousedown: the state fell back to `checking`, `row` went null, and Vue disabled the button
 * before mouseup, so the click was never dispatched. The button came back enabled a moment later
 * having done nothing, which reads as a dead button rather than as a race. (The `start-from-design`
 * tour hit the same edge, its `advanceOn: 'target-click'` step waiting on a click that never fired.)
 *
 * Guarding on the TEXT rather than suppressing the blur is what makes it a fix instead of a
 * workaround: re-resolving input that already has a verdict spends one HTTP call per connected
 * design source to arrive back where it started, whoever caused it.
 */
const resolvedFor = ref<string | null>(null)

watch(open, (isOpen) => {
  if (!isOpen) return
  pasted.value = ''
  state.value = { status: 'none' }
  claimant.value = null
  resolvedFor.value = null
})

const row = computed(() => refRowFor(state.value, pasted.value))
const sources = computed(() => documents.connectedDesignSources)

/**
 * The source the staged reference will be attached to.
 *
 * An UNCHECKED paste (the pre-flight itself failed: offline, a 502, a proxy's error page) is not
 * a refusal, so it stays stageable with the import as the backstop it always was — but only when
 * ONE design source is connected, because that is the only case where nothing has to be guessed.
 * With two, the source is exactly what the resolve was going to tell us, and picking the
 * first-registered one would attach a Zeplin screen to Figma's key space. Then the honest answer
 * is to say the check could not be made and let the person retry.
 */
const target = computed<DocumentSourceKind | null>(() => {
  if (claimant.value) return claimant.value
  if (state.value.status !== 'unchecked') return null
  return sources.value.length === 1 ? (sources.value[0] ?? null) : null
})

/**
 * Ask each connected design source in turn and keep the FIRST that claims the paste.
 *
 * Sequential rather than parallel: the sources are ordered by how much a claim over a URL is
 * worth, and running them together would make the winner whichever answered first. A refusal from
 * one source is not a refusal of the paste, so only the LAST one is surfaced when nobody claims
 * it — that is the state where the person genuinely has to change something.
 */
async function resolve() {
  const text = pasted.value.trim()
  // Already judged, so there is nothing to learn and a verdict to lose (see `resolvedFor`).
  if (text === resolvedFor.value) return
  claimant.value = null
  if (!text) {
    state.value = { status: 'none' }
    resolvedFor.value = null
    return
  }
  state.value = { status: 'checking' }
  let last: RefState = { status: 'rejected', reason: 'document_ref_unrecognized' }
  for (const source of sources.value) {
    try {
      const ref: ResolvedDocumentRef = await documents.resolveRef(source, text)
      claimant.value = source
      state.value = { status: 'ok', ref }
      resolvedFor.value = text
      return
    } catch (e) {
      last = classifyRefFailure(e)
      // An outage leaves the paste UNJUDGED rather than refused, and asking the next source
      // would turn one source being down into a different source's verdict.
      if (last.status === 'unchecked') break
    }
  }
  state.value = last
  // A refusal and an outage are verdicts too: re-running on the same text would reach the same
  // one, and an `unchecked` paste is stageable, so it must survive the blur Continue causes.
  resolvedFor.value = text
}

/**
 * Hand the resolved reference to the add-task form as a staged attachment.
 *
 * `needsImport` is true because nothing has been fetched yet: the form's own pre-create resolve
 * (`useContextLinking().resolvePending`) performs the import, which is where an unreachable page
 * becomes a correction the author can still make. Importing here as well would spend the fetch
 * twice and move the failure back before the form exists.
 */
function stage() {
  const frame = ui.startFromDesign
  const resolved = row.value
  const source = target.value
  if (!frame || !resolved || !source) return
  const descriptor = documents.descriptorFor(source)
  ui.closeStartFromDesign()
  ui.openAddTask(frame.frameId, {
    context: [
      {
        kind: 'document',
        source,
        externalId: resolved.externalId,
        title: resolved.label,
        subtitle: descriptor?.label,
        icon: descriptor?.icon,
        needsImport: true,
      },
    ],
  })
}
</script>

<template>
  <UModal v-model:open="open" :title="t('documents.startFromDesign.title')">
    <template #body>
      <div class="space-y-4">
        <p class="text-sm text-slate-400">{{ t('documents.startFromDesign.intro') }}</p>

        <!-- No connected design source: the flow cannot run, and saying which step is missing
             beats an input that refuses every paste. The connect route is withheld from a member
             for the same reason the picker's add tier is: connecting stores a credential. -->
        <p v-if="sources.length === 0" class="text-sm text-amber-300">
          {{ t('documents.startFromDesign.noSource') }}
        </p>

        <template v-else>
          <UFormField :label="t('documents.startFromDesign.linkLabel')">
            <UInput
              v-model="pasted"
              :placeholder="t('documents.startFromDesign.linkPlaceholder')"
              class="w-full"
              data-testid="start-from-design-link"
              @blur="resolve"
              @keyup.enter="resolve"
            />
          </UFormField>

          <div
            v-if="state.status === 'checking'"
            class="flex items-center gap-2 text-sm text-slate-400"
          >
            <UIcon name="i-lucide-loader" class="h-4 w-4 animate-spin" />
            {{ t('documents.startFromDesign.checking') }}
          </div>

          <div
            v-else-if="row"
            class="space-y-1 rounded-lg border border-slate-800 bg-slate-900/60 p-3"
            data-testid="start-from-design-resolved"
          >
            <div class="flex items-center gap-2 text-sm text-white">
              <UIcon name="i-lucide-frame" class="h-4 w-4 text-indigo-400" />
              <span class="truncate">{{ row.label }}</span>
            </div>
            <p v-if="row.trimmed" class="text-[11px] text-slate-400">
              {{ t('documents.startFromDesign.trimmed') }}
            </p>
            <!-- Its own line, in amber: a trim resolves the same page, a drop widens ONE frame to
                 the whole design file, and the second is what a designer needs to see. -->
            <p v-if="row.droppedScope" class="text-[11px] text-amber-300">
              {{ t('documents.startFromDesign.widened', { scope: row.droppedScope }) }}
            </p>
            <p v-if="row.unchecked && target" class="text-[11px] text-slate-400">
              {{ t('documents.startFromDesign.unchecked') }}
            </p>
            <p v-else-if="row.unchecked" class="text-[11px] text-amber-300">
              {{ t('documents.startFromDesign.uncheckedAmbiguous') }}
            </p>
          </div>

          <p
            v-else-if="state.status === 'rejected'"
            class="text-sm text-amber-300"
            data-testid="start-from-design-rejected"
          >
            {{ t('documents.startFromDesign.rejected') }}
          </p>
        </template>

        <div class="flex justify-end gap-2 pt-1">
          <UButton color="neutral" variant="ghost" @click="ui.closeStartFromDesign()">
            {{ t('common.cancel') }}
          </UButton>
          <UButton
            color="primary"
            icon="i-lucide-arrow-right"
            :disabled="!row || !target"
            data-testid="start-from-design-continue"
            @click="stage"
          >
            {{ t('documents.startFromDesign.continue') }}
          </UButton>
        </div>
      </div>
    </template>
  </UModal>
</template>
