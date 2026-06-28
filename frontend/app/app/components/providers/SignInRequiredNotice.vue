<script setup lang="ts">
// A guard banner for a per-USER credential form (personal subscriptions, your own API
// keys) when there is no signed-in user to store it against. On auth-enabled deployments
// and in local mode the app forces a login before these forms are reachable, so this only
// surfaces on a deployment running WITHOUT sign-in (auth fully disabled, non-local) — where
// storing would 401. It blocks the inputs and explains why, instead of letting the user
// type a token that can't be saved.
defineProps<{ message: string }>()
</script>

<template>
  <div
    class="flex items-start gap-2.5 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-200"
    role="alert"
  >
    <UIcon name="i-lucide-lock" class="mt-0.5 h-4 w-4 shrink-0" />
    <p>{{ message }}</p>
  </div>
</template>
