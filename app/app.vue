<script setup lang="ts">
import AuthGate from '~/components/auth/AuthGate.vue'
</script>

<template>
  <UApp>
    <AuthGate>
      <NuxtPage />
    </AuthGate>
  </UApp>
</template>
