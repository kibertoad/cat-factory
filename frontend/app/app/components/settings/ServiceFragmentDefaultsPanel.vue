<script setup lang="ts">
// Workspace settings: the default best-practice fragments NEW services inherit. The
// selection is drawn from the board's merged fragment catalog (built-in ∪ registered ∪
// account ∪ workspace via the fragments store; the static GET /prompt-fragments pool
// when the library is off). Changing it does not retroactively change existing
// services — each owns its selection from creation. Persisted via the
// serviceFragmentDefaults store (the backend replaces the whole list on each change).
import { onMounted, ref } from 'vue'
import { buildFragmentPickerGroups } from '~/utils/fragmentPicker'
import SectionLabel from '~/components/common/SectionLabel.vue'

const { t } = useI18n()
const fragments = useFragmentsStore()
const defaults = useServiceFragmentDefaultsStore()
const ui = useUiStore()
const { present } = usePipelineErrorToast()

const busy = ref(false)

// The tab renders when Workspace settings opens; load the fragment pool then.
onMounted(() => void fragments.ensureLoaded())

// An id the catalog no longer resolves still renders (labelled by its raw id) so it
// stays visible and removable from the default set.
const selected = computed(() =>
  defaults.fragmentIds.map((id) => fragments.getFragment(id) ?? { id, title: id, summary: '' }),
)

// Pool fragments not already in the default set, grouped into labelled per-category sections.
const menu = computed(() => {
  const chosen = new Set(defaults.fragmentIds)
  return buildFragmentPickerGroups(fragments.fragments, (id) => chosen.has(id), add)
})

async function save(ids: string[]) {
  busy.value = true
  try {
    await defaults.set(ids)
  } catch (e) {
    present(e, 'settings.serviceFragmentDefaults.saveFailed')
  } finally {
    busy.value = false
  }
}

function add(id: string) {
  if (defaults.fragmentIds.includes(id)) return
  void save([...defaults.fragmentIds, id])
}

function remove(id: string) {
  void save(defaults.fragmentIds.filter((x) => x !== id))
}
</script>

<template>
  <div class="space-y-4">
    <p class="text-xs text-muted">
      {{ t('settings.serviceFragmentDefaults.intro') }}
    </p>

    <div class="flex items-center justify-between">
      <SectionLabel as="span">
        {{ t('settings.serviceFragmentDefaults.defaultFragments') }}
      </SectionLabel>
      <UDropdownMenu v-if="menu.length" :items="menu" :ui="{ content: 'max-h-72 overflow-y-auto' }">
        <UButton
          size="xs"
          variant="ghost"
          color="neutral"
          icon="i-lucide-plus"
          trailing-icon="i-lucide-chevron-down"
          :loading="busy"
        >
          {{ t('settings.serviceFragmentDefaults.addFragment') }}
        </UButton>
      </UDropdownMenu>
    </div>

    <div v-if="selected.length" class="flex flex-wrap gap-1">
      <UBadge
        v-for="f in selected"
        :key="f.id"
        color="primary"
        variant="subtle"
        size="sm"
        class="cursor-pointer"
        :title="f.summary"
        @click="remove(f.id)"
      >
        {{ f.title }}<UIcon name="i-lucide-x" class="ms-0.5 h-3 w-3" />
      </UBadge>
    </div>
    <p v-else class="text-2xs text-dimmed">
      {{ t('settings.serviceFragmentDefaults.empty') }}
    </p>

    <div class="flex flex-wrap gap-x-4 gap-y-1 border-t border-default pt-3 text-2xs">
      <span class="text-dimmed">
        {{ t('settings.serviceFragmentDefaults.footer.question') }}
      </span>
      <UButton
        color="primary"
        variant="link"
        class="font-medium text-primary hover:underline"
        @click="ui.openFragmentLibrary()"
      >
        {{ t('settings.serviceFragmentDefaults.footer.manageBoard') }}
      </UButton>
      <UButton
        color="primary"
        variant="link"
        class="font-medium text-primary hover:underline"
        @click="ui.openAccountSettings('fragments')"
      >
        {{ t('settings.serviceFragmentDefaults.footer.manageAccount') }}
      </UButton>
    </div>
  </div>
</template>
