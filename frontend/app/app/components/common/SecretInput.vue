<script setup lang="ts">
// Shared single-line secret/password input with a reveal (eye) toggle (UX-19/UX-20).
// Masks the value by default (`type="password"`) and lets the user verify a pasted token via
// the trailing eye button — without one, a mistyped/expired key looks identical to a good one,
// the leading cause of invalid-credential retries. Replaces both the bare `type="password"`
// UInputs (UX-19) and the fully-plaintext secret `UTextarea`s (UX-20), which rendered live
// vendor keys in cleartext (shoulder-surf / screen-share leakage).
//
// When `secret` is false it degrades to a plain text input with no toggle, so descriptor-driven
// fields whose secrecy is data-dependent (`field.secret ? … : …`) can bind it directly.
// All other UInput props/listeners (icon, size, placeholder, disabled, autofocus, class, …)
// pass straight through via `$attrs`; `secret` is a declared prop so it strips off first.
// `$attrs` is bound BEFORE `type` so the mask/reveal control stays authoritative — a caller
// that (out of old habit) also passes `type="password"` can't clobber the toggle.
// Mirrors the shape of `common/CopyButton.vue` / `common/IconButton.vue`.
const props = withDefaults(
  defineProps<{
    /** Whether the field holds a secret (masked + reveal toggle). When false, a plain text input. */
    secret?: boolean
  }>(),
  { secret: true },
)

const model = defineModel<string>()
const { t } = useI18n()
const revealed = ref(false)
const toggle = () => {
  revealed.value = !revealed.value
}
defineOptions({ inheritAttrs: false })
</script>

<template>
  <UInput v-if="!props.secret" v-model="model" v-bind="$attrs" type="text" />
  <UInput v-else v-model="model" v-bind="$attrs" :type="revealed ? 'text' : 'password'">
    <template #trailing>
      <UButton
        color="neutral"
        variant="link"
        size="xs"
        :icon="revealed ? 'i-lucide-eye-off' : 'i-lucide-eye'"
        :title="revealed ? t('common.hide') : t('common.reveal')"
        :aria-label="revealed ? t('common.hide') : t('common.reveal')"
        :aria-pressed="revealed"
        @click.stop="toggle"
      />
    </template>
  </UInput>
</template>
