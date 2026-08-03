<script setup lang="ts">
// Capability credentials — the sealed, per-workspace values behind the secrets a registered tool
// server (MCP) or generative binary integration declares BY NAME. It renders as a CHECKLIST, not
// a blank key-value form: which keys exist is a property of the deployment's CODE, so the panel
// projects the declarations and the operator fills them in. A blank form would mean reading the
// deployment's source to learn what to type, with a typo producing a sealed row nothing asks for.
//
// Values are write-only and saved ONE KEY AT A TIME. The whole-set write is unusable here: this
// client never receives the values, so replacing the set would delete every credential the
// operator did not retype in this sitting.
//
// Renders inside the Infrastructure window's "Capability credentials" tab: what an agent's tools
// authenticate as is part of where agents RUN. `secrets.manage`-gated end to end (the READ
// included — the view names the deployment's credential keys), so the tab is HIDDEN, never
// disabled, for anyone without it.
import { computed, onMounted, reactive, ref } from 'vue'
import type { CapabilityCredentialStatus } from '~/types/capabilityCredentials'
import SecretInput from '~/components/common/SecretInput.vue'

const { t, d } = useI18n()
const store = useCapabilityCredentialsStore()
const toast = useToast()
const { confirmAction, toastDone } = useConfirmAction()

// Which declaring capability wants a key. An exhaustive Record over the wire union, so a new
// subject fails to compile until it has translated copy — the sanctioned guard for an enum-keyed
// lookup the typed-message-key check cannot see.
type CredentialSubject = CapabilityCredentialStatus['declaredBy'][number]['subject']
const SUBJECT_LABELS = computed<Record<CredentialSubject, string>>(() => ({
  'tool-server': t('settings.capabilityCredentials.subject.toolServer'),
  'binary-generator': t('settings.capabilityCredentials.subject.binaryGenerator'),
}))

// Draft values, keyed by credential key. Never prefilled: nothing here was ever read back, and a
// masked placeholder standing in for a stored value would make "unchanged" and "retyped" look
// identical at the save button.
const drafts = reactive<Record<string, string>>({})
// Which row's WHICH button is in flight. The action is part of the state because save and delete
// sit beside each other on one row: a shared per-key flag would spin the delete button for the
// save the user just clicked, which reads as a delete in progress.
const busy = ref<{ key: string; action: 'save' | 'remove' } | null>(null)
// Failures present through the shared status-class funnel (translated description up front, the
// raw backend prose + requestId behind "Show details"), never raw `e.message` as the description.
const { present } = usePipelineErrorToast()

const view = computed(() => store.view)

function isBusy(key: string, action: 'save' | 'remove') {
  return busy.value?.key === key && busy.value.action === action
}

// The tab this renders in only exists once the window's probe resolved `available === true`, so
// `ensureLoaded()` here would early-return every time and this error branch would be dead code.
// Read outright instead: the window owns the PROBE (a failure there means no tab), the panel owns
// the DATA (a failure here means the reader is looking at a list we could not fetch, and must be
// told). It also drops the staleness `ensureLoaded` carried, so reopening the tab after the
// deployment registered a new capability shows the new key.
onMounted(async () => {
  try {
    await store.load()
  } catch (e) {
    present(e, 'settings.capabilityCredentials.toast.loadFailed')
  }
})

async function saveKey(key: string) {
  const value = (drafts[key] ?? '').trim()
  if (!value) return
  busy.value = { key, action: 'save' }
  try {
    await store.save(key, value)
    drafts[key] = ''
    toast.add({
      title: t('settings.capabilityCredentials.toast.saved', { key }),
      icon: 'i-lucide-check',
      color: 'success',
    })
  } catch (e) {
    present(e, 'settings.capabilityCredentials.toast.saveFailed')
  } finally {
    busy.value = null
  }
}

async function removeKey(key: string) {
  const noun = t('settings.capabilityCredentials.credentialNoun', { key })
  if (!(await confirmAction('remove', noun))) return
  busy.value = { key, action: 'remove' }
  try {
    await store.remove(key)
    toastDone('remove', noun)
  } catch (e) {
    present(e, 'settings.capabilityCredentials.toast.removeFailed')
  } finally {
    busy.value = null
  }
}
</script>

<template>
  <div class="space-y-4" data-testid="capability-credentials-panel">
    <p class="text-sm text-slate-400">
      {{ t('settings.capabilityCredentials.intro') }}
    </p>

    <!-- The declaration read failed (the deployment's generative integrations could not be
         reached), so this checklist may be SHORT and the orphan list is withheld. Said out loud
         rather than rendered as a clean empty list: an outage and "nothing needs a credential"
         are the same list and opposite facts. -->
    <UAlert
      v-if="view?.declarationsIncomplete"
      color="warning"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      :title="t('settings.capabilityCredentials.incomplete.title')"
      :description="t('settings.capabilityCredentials.incomplete.body')"
      data-testid="capability-credentials-incomplete"
    />

    <section
      v-for="entry in view?.declared ?? []"
      :key="entry.key"
      class="space-y-3 rounded-lg border border-slate-700 p-3"
      :data-testid="`capability-credential-${entry.key}`"
    >
      <div class="flex flex-wrap items-center gap-2">
        <code class="font-mono text-sm font-medium">{{ entry.key }}</code>
        <UBadge v-if="entry.required" color="warning" variant="soft" size="sm">
          {{ t('settings.capabilityCredentials.required') }}
        </UBadge>
        <UBadge v-else color="neutral" variant="soft" size="sm">
          {{ t('settings.capabilityCredentials.optional') }}
        </UBadge>
        <UBadge
          v-if="entry.stored"
          color="success"
          variant="soft"
          size="sm"
          :data-testid="`capability-credential-stored-${entry.key}`"
        >
          {{ t('settings.capabilityCredentials.stored') }}
        </UBadge>
      </div>

      <!-- Who wants the value, so an operator can tell what they are about to change. One key is
           routinely wanted by more than one capability (two integrations behind one vendor
           account), which is exactly when a rotation has consequences beyond the row it edits. -->
      <ul class="space-y-1 text-xs text-slate-400">
        <li v-for="declarer in entry.declaredBy" :key="`${declarer.subject}:${declarer.id}`">
          <span class="text-slate-300">{{ declarer.label }}</span>
          <span class="text-slate-500"> · {{ SUBJECT_LABELS[declarer.subject] }}</span>
          <span v-if="declarer.usage" class="block text-slate-500">{{ declarer.usage }}</span>
        </li>
      </ul>

      <p v-if="entry.stored && entry.updatedAt" class="text-[11px] text-slate-500">
        {{
          t('settings.capabilityCredentials.storedAt', {
            date: d(new Date(entry.updatedAt), 'short'),
          })
        }}
      </p>
      <!-- An EMPTY row is not the same fact in every deployment, so it must not read the same way.
           Three states, and the backend reports them off the chain it actually composed: with the
           fallback the deployment's own environment may still answer, and calling that "missing"
           would send an operator hunting for a value that is already resolving; without it, blank
           really does mean the capability cannot authenticate. The third is a deployment that
           supplied its OWN resolver, which replaced the chain — neither claim is ours to make, so
           this says what is known and stops there. -->
      <p v-else-if="view?.environmentFallback === true" class="text-[11px] text-slate-500">
        {{ t('settings.capabilityCredentials.notStoredWithFallback') }}
      </p>
      <p v-else-if="view?.environmentFallback === false" class="text-[11px] text-amber-400">
        {{ t('settings.capabilityCredentials.notStored') }}
      </p>
      <p v-else class="text-[11px] text-slate-500">
        {{ t('settings.capabilityCredentials.notStoredUnknownFallback') }}
      </p>

      <div class="flex items-end gap-2">
        <UFormField
          class="flex-1"
          :label="
            entry.stored
              ? t('settings.capabilityCredentials.replaceValue')
              : t('settings.capabilityCredentials.setValue')
          "
        >
          <SecretInput
            v-model="drafts[entry.key]"
            class="w-full"
            :data-testid="`capability-credential-input-${entry.key}`"
            @keyup.enter="saveKey(entry.key)"
          />
        </UFormField>
        <UButton
          :loading="isBusy(entry.key, 'save')"
          :disabled="!(drafts[entry.key] ?? '').trim() || isBusy(entry.key, 'remove')"
          :data-testid="`capability-credential-save-${entry.key}`"
          @click="saveKey(entry.key)"
        >
          {{ t('settings.capabilityCredentials.save') }}
        </UButton>
        <UButton
          v-if="entry.stored"
          color="error"
          variant="ghost"
          icon="i-lucide-trash-2"
          :loading="isBusy(entry.key, 'remove')"
          :disabled="isBusy(entry.key, 'save')"
          :data-testid="`capability-credential-delete-${entry.key}`"
          :aria-label="t('settings.capabilityCredentials.remove')"
          @click="removeKey(entry.key)"
        />
      </div>
    </section>

    <p
      v-if="view && !view.declared.length && !view.declarationsIncomplete"
      class="text-sm text-slate-500"
    >
      {{ t('settings.capabilityCredentials.noneDeclared') }}
    </p>

    <!-- Stored keys nothing declares any more: a live secret nobody will ever ask for, which is
         what a retired integration or a renamed variable leaves behind. Listed rather than
         filtered, because only the operator can tell "delete this" from "the deployment
         regressed". Withheld entirely while the declaration read is incomplete. -->
    <section
      v-if="view?.orphaned.length"
      class="space-y-2 rounded-lg border border-amber-900/60 p-3"
      data-testid="capability-credentials-orphaned"
    >
      <h3 class="text-sm font-semibold">
        {{ t('settings.capabilityCredentials.orphaned.heading') }}
      </h3>
      <p class="text-xs text-slate-400">
        {{ t('settings.capabilityCredentials.orphaned.body') }}
      </p>
      <div
        v-for="orphan in view.orphaned"
        :key="orphan.key"
        class="flex items-center justify-between gap-2 rounded-md border border-slate-800 px-3 py-2"
      >
        <div class="min-w-0">
          <code class="font-mono text-sm">{{ orphan.key }}</code>
          <span class="block text-[11px] text-slate-500">
            {{
              t('settings.capabilityCredentials.storedAt', {
                date: d(new Date(orphan.updatedAt), 'short'),
              })
            }}
          </span>
        </div>
        <UButton
          color="error"
          variant="ghost"
          icon="i-lucide-trash-2"
          size="sm"
          :loading="isBusy(orphan.key, 'remove')"
          :data-testid="`capability-credential-delete-${orphan.key}`"
          :aria-label="t('settings.capabilityCredentials.remove')"
          @click="removeKey(orphan.key)"
        />
      </div>
    </section>
  </div>
</template>
