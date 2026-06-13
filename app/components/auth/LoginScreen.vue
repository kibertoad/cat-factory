<script setup lang="ts">
const auth = useAuthStore()
</script>

<template>
  <div class="flex h-screen w-screen items-center justify-center bg-slate-950 text-slate-100">
    <div
      class="w-full max-w-sm rounded-xl border border-slate-800 bg-slate-900/80 p-8 text-center backdrop-blur"
    >
      <UIcon name="i-lucide-layout-dashboard" class="mx-auto mb-3 h-10 w-10 text-indigo-400" />
      <h1 class="mb-1 text-lg font-semibold text-white">Architecture Board</h1>
      <p class="mb-6 text-sm text-slate-400">Sign in with your GitHub account to continue.</p>
      <UButton block size="lg" color="primary" icon="i-lucide-github" @click="auth.login()">
        Sign in with GitHub
      </UButton>
    </div>
  </div>
</template>
