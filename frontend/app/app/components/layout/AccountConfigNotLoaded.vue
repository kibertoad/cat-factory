<script setup lang="ts">
// Shown in place of a Team-tab panel's editor when the account's settings did not load. A save
// replaces the whole account config and the panel edits one key of it, so with the current
// config not in hand there is nothing to carry forward: the editor is hidden and the save
// disabled, and this says why.
const { t } = useI18n()
</script>

<template>
  <p
    class="rounded-lg border border-app-warning-800/60 bg-app-warning-950/30 px-3 py-2 text-xs text-app-warning-200"
  >
    {{ t('settings.account.configNotLoaded') }}
  </p>
</template>
