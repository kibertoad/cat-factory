<script setup lang="ts">
// What this tier is opted OUT of (backend/docs/adr/0031-foundational-services.md). A suppressed id is
// by construction absent from the merged catalog, so without this list the suppress action would
// be a one-way door — which is why it is a section of its own rather than a badge on the catalog.
//
// Rendered at BOTH scopes, because both inherit: a board from its account, and either from the
// services the deployment registered in code (the `builtin` tier).
//
// `inherited: false` is rendered distinctly rather than hidden: the tombstone shadows nothing
// today (the tier below withdrew the service, or this row is what remains of this tier deleting
// its own registration), and an operator reading it as "a capability is being withheld" would go
// looking for something that is not there.
import { computed, reactive } from 'vue'
import type { FoundationalServiceOwnerKind } from '~/types/domain'
import {
  useFoundationalServices,
  useFoundationalServicesStore,
} from '~/stores/foundationalServices'

const props = defineProps<{ kind: FoundationalServiceOwnerKind; ownerId: string }>()

const catalog =
  props.kind === 'workspace'
    ? useFoundationalServicesStore()
    : useFoundationalServices(props.kind, props.ownerId)
const toast = useToast()
const { t } = useI18n()

// Exhaustive scope→key maps of literal `t(...)` keys: what a board opts out of (its account's
// services) and what an account opts out of (the deployment's) are different enough sentences
// that one string with a placeholder would read as neither.
const title = computed<Record<FoundationalServiceOwnerKind, string>>(() => ({
  workspace: t('foundational.suppressions.title.workspace'),
  account: t('foundational.suppressions.title.account'),
}))
const intro = computed<Record<FoundationalServiceOwnerKind, string>>(() => ({
  workspace: t('foundational.suppressions.intro.workspace'),
  account: t('foundational.suppressions.intro.account'),
}))

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
    <p class="text-sm font-medium">{{ title[props.kind] }}</p>
    <p class="text-xs text-slate-500">{{ intro[props.kind] }}</p>
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
