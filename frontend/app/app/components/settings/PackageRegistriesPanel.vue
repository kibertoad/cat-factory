<script setup lang="ts">
// Private package registries — the workspace's npm-registry entries (npm private
// orgs, GitHub Packages) that agent containers use to resolve private dependencies
// on checkout. Tokens are write-only: the list renders from the redacted summary
// (vendor + scopes + token tail) and an entry is edited by deleting + re-adding.
// Renders inline inside the Infrastructure window's "Package registries" tab: what a
// checkout installs from is part of where agent containers RUN, not an optional
// external system the workspace links in.
import { computed, onMounted, reactive, ref } from 'vue'
import type { PackageRegistryVendor } from '~/types/packageRegistries'
import SecretInput from '~/components/common/SecretInput.vue'

const { t } = useI18n()
const store = usePackageRegistriesStore()
const toast = useToast()
const { present } = usePipelineErrorToast()
const { confirmAction, toastDone } = useConfirmAction()

// The registry vendors a workspace can connect. Fixed set — the host derives from the
// vendor server-side, so it renders read-only here. Vendor names stay verbatim.
const VENDORS: { value: PackageRegistryVendor; label: string; host: string }[] = [
  { value: 'npmjs', label: 'npm (npmjs.com)', host: 'registry.npmjs.org' },
  { value: 'github-packages', label: 'GitHub Packages', host: 'npm.pkg.github.com' },
]

const form = reactive({
  vendor: 'npmjs' as PackageRegistryVendor,
  scopes: '',
  token: '',
})
const busy = ref(false)

const vendorHost = computed(() => VENDORS.find((v) => v.value === form.vendor)?.host ?? '')

function vendorLabel(vendor: PackageRegistryVendor): string {
  return VENDORS.find((v) => v.value === vendor)?.label ?? vendor
}

/** Parse the comma/space-separated scopes input into `@org` entries. */
const parsedScopes = computed(() =>
  form.scopes
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (s.startsWith('@') ? s : `@${s}`)),
)

// The tab this renders in only exists once the window's probe resolved `available === true`, so
// `ensureLoaded()` here would early-return every time and this error branch would be dead code.
// Read the list outright instead: the window owns the PROBE (a failure there means no tab), the
// panel owns the DATA (a failure here means the reader is looking at a list we could not fetch,
// and must be told). It also drops the staleness `ensureLoaded` carried — reopening the tab
// after an entry was added elsewhere used to re-render the first load's snapshot.
onMounted(async () => {
  try {
    await store.load()
  } catch (e) {
    present(e, 'settings.packageRegistries.toast.loadFailed')
  }
})

async function addEntry() {
  busy.value = true
  try {
    await store.add({
      ecosystem: 'npm',
      vendor: form.vendor,
      scopes: parsedScopes.value,
      token: form.token.trim(),
    })
    form.scopes = ''
    form.token = ''
    toast.add({
      title: t('settings.packageRegistries.toast.added'),
      icon: 'i-lucide-check',
      color: 'success',
    })
  } catch (e) {
    present(e, 'settings.packageRegistries.toast.addFailed')
  } finally {
    busy.value = false
  }
}

async function removeEntry(entryId: string) {
  const noun = t('settings.packageRegistries.entryNoun')
  if (!(await confirmAction('remove', noun))) return
  busy.value = true
  try {
    await store.remove(entryId)
    toastDone('remove', noun)
  } catch (e) {
    present(e, 'settings.packageRegistries.toast.removeFailed')
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="space-y-4" data-testid="package-registries-panel">
    <p class="text-sm text-slate-400">
      {{ t('settings.packageRegistries.intro') }}
    </p>

    <section v-if="store.entries.length" class="space-y-2 rounded-lg border border-slate-700 p-3">
      <h3 class="text-sm font-semibold">
        {{ t('settings.packageRegistries.list.heading') }}
      </h3>
      <div
        v-for="entry in store.entries"
        :key="entry.id"
        class="flex items-center justify-between gap-2 rounded-md border border-slate-800 px-3 py-2"
      >
        <div class="min-w-0 space-y-1">
          <div class="flex items-center gap-2">
            <span class="text-sm font-medium">{{ vendorLabel(entry.vendor) }}</span>
            <span class="text-[11px] text-slate-500">
              {{ t('settings.packageRegistries.list.tokenTail', { tail: entry.tokenTail }) }}
            </span>
          </div>
          <div class="flex flex-wrap gap-1">
            <UBadge
              v-for="scope in entry.scopes"
              :key="scope"
              color="neutral"
              variant="soft"
              size="sm"
            >
              {{ scope }}
            </UBadge>
            <!-- An entry with no scopes authenticates its host without routing any scope to
                 it (the deliberate mixed public/private setup) — say so, or the row reads as
                 half-configured. -->
            <span v-if="!entry.scopes.length" class="text-[11px] text-slate-500">
              {{ t('settings.packageRegistries.list.noScopes') }}
            </span>
          </div>
        </div>
        <UButton
          color="error"
          variant="ghost"
          icon="i-lucide-trash-2"
          size="sm"
          :loading="busy"
          :data-testid="`package-registry-delete-${entry.id}`"
          :aria-label="t('settings.packageRegistries.list.remove')"
          @click="removeEntry(entry.id)"
        />
      </div>
    </section>

    <section class="space-y-3 rounded-lg border border-slate-700 p-3">
      <h3 class="text-sm font-semibold">
        {{ t('settings.packageRegistries.add.heading') }}
      </h3>

      <UFormField :label="t('settings.packageRegistries.add.vendor')">
        <USelect
          v-model="form.vendor"
          :items="VENDORS"
          value-key="value"
          class="w-full"
          data-testid="package-registry-vendor"
        />
      </UFormField>
      <p class="text-[11px] text-slate-500">
        {{ t('settings.packageRegistries.add.host', { host: vendorHost }) }}
      </p>

      <UFormField
        :label="t('settings.packageRegistries.add.scopes')"
        :help="t('settings.packageRegistries.add.scopesHelp')"
      >
        <UInput
          v-model="form.scopes"
          placeholder="@my-org, @my-other-org"
          class="w-full"
          data-testid="package-registry-scopes"
        />
      </UFormField>
      <!-- What will actually be SAVED. The parse splits on commas/whitespace and prefixes a
           missing `@`, so the field's text and the stored scopes routinely differ — and now
           that an empty list is a legitimate save, "I typed something that parsed to nothing"
           and "I meant to leave this empty" would otherwise look identical at the button. -->
      <div v-if="parsedScopes.length" class="flex flex-wrap gap-1">
        <UBadge
          v-for="scope in parsedScopes"
          :key="scope"
          color="neutral"
          variant="soft"
          size="sm"
          data-testid="package-registry-parsed-scope"
        >
          {{ scope }}
        </UBadge>
      </div>
      <!-- Why leaving this empty is often the RIGHT answer — a scope mapping is all-or-nothing,
           so an org publishing some of its `@org` packages publicly breaks under one. -->
      <p class="text-[11px] text-slate-500">
        {{ t('settings.packageRegistries.add.scopesNote') }}
      </p>

      <UFormField :label="t('settings.packageRegistries.add.token')">
        <SecretInput v-model="form.token" class="w-full" data-testid="package-registry-token" />
      </UFormField>

      <UButton
        :loading="busy"
        :disabled="!form.token.trim()"
        data-testid="package-registry-save"
        @click="addEntry"
      >
        {{ t('settings.packageRegistries.add.save') }}
      </UButton>
    </section>
  </div>
</template>
