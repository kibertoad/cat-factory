<script setup lang="ts">
// What this board is opted OUT of (backend/docs/adr/0031-foundational-services.md). A suppressed id is
// by construction absent from the merged catalog, so without this list the suppress action would
// be a one-way door — which is why it is a section of its own rather than a badge on the catalog.
//
// `inherited: false` is rendered distinctly rather than hidden: the tombstone shadows nothing
// today (the account withdrew the service, or this row is what remains of the board deleting its
// own registration), and an operator reading it as "a capability is being withheld" would go
// looking for something that is not there.
import { reactive } from 'vue'
import { useFoundationalServicesStore } from '~/stores/foundationalServices'

const catalog = useFoundationalServicesStore()
const toast = useToast()
const { t } = useI18n()

const busyRows = reactive(new Set<string>())
const rowBusy = (id: string) => busyRows.has(id)

async function restore(serviceId: string) {
  if (busyRows.has(serviceId)) return
  busyRows.add(serviceId)
  try {
    await catalog.restore(serviceId)
    toast.add({ title: t('foundational.toast.restored'), icon: 'i-lucide-eye' })
  } catch (e) {
    toast.add({
      title: t('foundational.toast.restoreFailed'),
      description: e instanceof Error ? e.message : String(e),
      icon: 'i-lucide-triangle-alert',
      color: 'error',
    })
  } finally {
    busyRows.delete(serviceId)
  }
}
</script>

<template>
  <div
    v-if="catalog.suppressions.length"
    class="flex flex-col gap-2"
    data-testid="foundational-suppressions"
  >
    <p class="text-sm font-medium">{{ t('foundational.suppressions.title') }}</p>
    <p class="text-xs text-slate-500">{{ t('foundational.suppressions.intro') }}</p>
    <div
      v-for="s in catalog.suppressions"
      :key="s.id"
      class="flex items-center gap-2 rounded-md border border-slate-800 bg-slate-900/40 p-3"
    >
      <UIcon name="i-lucide-eye-off" class="h-4 w-4 shrink-0 text-slate-500" />
      <div class="min-w-0 flex-1">
        <p class="truncate text-sm text-slate-300">
          {{ s.name || s.id }}
          <code v-if="s.name" class="ms-1 text-[11px] text-slate-500">{{ s.id }}</code>
        </p>
        <p v-if="s.summary" class="text-xs text-slate-500">{{ s.summary }}</p>
        <p v-if="!s.inherited" class="text-[11px] text-slate-500">
          {{ t('foundational.suppressions.shadowsNothing') }}
        </p>
      </div>
      <UButton
        icon="i-lucide-eye"
        size="xs"
        variant="ghost"
        :loading="rowBusy(s.id)"
        :data-testid="`foundational-restore-${s.id}`"
        @click="restore(s.id)"
      >
        {{ t('foundational.suppressions.restore') }}
      </UButton>
    </div>
  </div>
</template>
