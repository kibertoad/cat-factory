<script setup lang="ts">
// Account-tier foundational services (backend/docs/adr/0031-foundational-services.md): the shared
// capabilities the whole organisation runs — file storage, notifications, audit — which every
// board in the account inherits and can override or opt out of. A body-only section rendered in
// the "Foundational services" tab of AccountSettingsPanel; available for ALL account types.
import FoundationalServiceManager from '~/components/foundational/FoundationalServiceManager.vue'

const props = defineProps<{ accountId: string }>()
const { t } = useI18n()
</script>

<template>
  <div class="space-y-6 text-sm">
    <section>
      <p class="mb-3 text-[11px] text-slate-400">
        {{ t('layout.accountFoundational.intro') }}
      </p>
      <FoundationalServiceManager
        kind="account"
        :owner-id="props.accountId"
        :show-catalog="false"
      />
    </section>
  </div>
</template>
