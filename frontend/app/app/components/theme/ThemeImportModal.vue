<script setup lang="ts">
import { ref, watch } from 'vue'
import { useThemeStore } from '~/stores/theme'
import { decodeThemeLink, type ThemeLinkDecodeResult } from '~/utils/theme/link'

// Import a theme built in the Nuxt UI theme editor (https://ui.nuxt.com/theme): the user pastes
// the editor's share link (or the raw document JSON), names it, and the theme is stored in this
// browser and applied. The document format is the editor's own (`utils/theme/doc.ts`), so there
// is no translation step to get wrong: what the editor previewed is what the app renders.
const open = defineModel<boolean>('open', { default: false })

const { t } = useI18n()
const theme = useThemeStore()

const link = ref('')
const name = ref('')
const error = ref<Extract<ThemeLinkDecodeResult, { ok: false }>['reason'] | null>(null)
const busy = ref(false)

// Static literal keys per decode outcome, so the typed-message-keys check sees them.
const ERROR_KEYS: Record<NonNullable<typeof error.value>, string> = {
  not_a_link: 'appearance.import.error.notALink',
  malformed: 'appearance.import.error.malformed',
  preset_shorthand: 'appearance.import.error.presetShorthand',
  unsupported_version: 'appearance.import.error.unsupportedVersion',
}

watch(open, (isOpen) => {
  if (!isOpen) return
  link.value = ''
  name.value = ''
  error.value = null
})

async function submit() {
  busy.value = true
  try {
    const result = await decodeThemeLink(link.value)
    if (!result.ok) {
      error.value = result.reason
      return
    }
    error.value = null
    theme.addCustom(name.value, result.doc)
    open.value = false
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="t('appearance.import.title')"
    :description="t('appearance.import.description')"
  >
    <template #body>
      <form class="space-y-4" data-testid="theme-import-form" @submit.prevent="submit">
        <UFormField
          :label="t('appearance.import.linkLabel')"
          :error="error ? t(ERROR_KEYS[error]) : undefined"
        >
          <UTextarea
            v-model="link"
            :rows="3"
            autoresize
            class="w-full font-mono text-xs"
            :placeholder="t('appearance.import.linkPlaceholder')"
            data-testid="theme-import-link"
          />
        </UFormField>
        <UFormField :label="t('appearance.import.nameLabel')">
          <UInput
            v-model="name"
            class="w-full"
            :placeholder="t('appearance.import.namePlaceholder')"
            data-testid="theme-import-name"
          />
        </UFormField>
        <p class="text-xs text-muted">{{ t('appearance.import.fontNote') }}</p>
        <div class="flex justify-end gap-2">
          <UButton color="neutral" variant="ghost" @click="open = false">
            {{ t('appearance.import.cancel') }}
          </UButton>
          <UButton
            type="submit"
            :loading="busy"
            :disabled="!link.trim()"
            data-testid="theme-import-submit"
          >
            {{ t('appearance.import.submit') }}
          </UButton>
        </div>
      </form>
    </template>
  </UModal>
</template>
