<script setup lang="ts">
import type { DropdownMenuItem } from '@nuxt/ui'

// Signed-in identity + sign-out, shown in the sidebar when auth is enabled.
const auth = useAuthStore()

const items = computed<DropdownMenuItem[][]>(() => [
  [
    {
      label: 'Sign out',
      icon: 'i-lucide-log-out',
      onSelect: () => auth.logout(),
    },
  ],
])
</script>

<template>
  <UDropdownMenu v-if="auth.user" :items="items" :content="{ side: 'top', align: 'start' }">
    <button
      type="button"
      class="flex w-full items-center gap-2 rounded-lg border border-slate-800 bg-slate-900/60 p-2 text-left transition hover:bg-slate-800/60"
    >
      <UAvatar
        :src="auth.user.avatarUrl ?? undefined"
        :alt="auth.user.login"
        size="xs"
        icon="i-lucide-user"
      />
      <div class="min-w-0 flex-1">
        <div class="truncate text-xs font-medium text-white">
          {{ auth.user.name || auth.user.login }}
        </div>
        <div class="truncate text-[10px] text-slate-500">@{{ auth.user.login }}</div>
      </div>
      <UIcon name="i-lucide-chevron-up" class="h-4 w-4 shrink-0 text-slate-500" />
    </button>
  </UDropdownMenu>
</template>
