<script setup lang="ts">
// The guided per-service Docker Compose environment setup, as a section of the Infrastructure
// window's "Test environments" tab.
//
// It used to be its own top-level sidebar destination called "Environment setup", which was
// wrong twice over: the name said nothing about WHAT it sets up (people read it as the place
// to configure environments in general, which is the rest of this tab), and a wizard that
// fills in one field of one service's config sat at the same level as the workspace-wide
// infrastructure it depends on. It lives here now, next to the two settings it writes: the
// service's provision type and the workspace's Docker Compose handler.
//
// The section deliberately carries a full explanation rather than a one-line hint. The wizard
// is a five-minute flow that touches a repo and can trial-provision a stack, so "when you need
// this / when you don't" has to be answerable BEFORE opening it — most services on most boards
// never need it at all.
import SectionLabel from '~/components/common/SectionLabel.vue'

const { t } = useI18n()
const ui = useUiStore()

/** Bullet lists rendered below; static literal keys so the typed-key check sees them. */
const steps = computed(() => [
  t('settings.composeEnvSetup.how.scan'),
  t('settings.composeEnvSetup.how.analyse'),
  t('settings.composeEnvSetup.how.preflight'),
  t('settings.composeEnvSetup.how.save'),
])
const needed = computed(() => [
  t('settings.composeEnvSetup.needed.running'),
  t('settings.composeEnvSetup.needed.compose'),
  t('settings.composeEnvSetup.needed.setup'),
])
const notNeeded = computed(() => [
  t('settings.composeEnvSetup.notNeeded.inContainer'),
  t('settings.composeEnvSetup.notNeeded.otherBackend'),
  t('settings.composeEnvSetup.notNeeded.noRepo'),
])

// The wizard is its own modal, so hand over rather than stacking: close this window first.
function start() {
  ui.closeProviderConnection()
  ui.openEnvironmentSetup()
}
</script>

<template>
  <section class="space-y-3" data-testid="compose-env-setup-section">
    <div>
      <h3 class="text-sm font-semibold text-default">
        {{ t('settings.composeEnvSetup.title') }}
      </h3>
      <p class="mt-1 text-xs leading-relaxed text-muted">
        {{ t('settings.composeEnvSetup.lead') }}
      </p>
    </div>

    <div class="rounded border border-default bg-default/40 p-3">
      <SectionLabel as="p">
        {{ t('settings.composeEnvSetup.how.title') }}
      </SectionLabel>
      <ol class="mt-2 list-decimal space-y-1 ps-4 text-2xs leading-relaxed text-muted">
        <li v-for="(step, i) in steps" :key="`how-${i}`">{{ step }}</li>
      </ol>
      <p class="mt-2 text-2xs leading-relaxed text-dimmed">
        {{ t('settings.composeEnvSetup.how.outcome') }}
      </p>
    </div>

    <div class="grid gap-2 sm:grid-cols-2">
      <div class="rounded border border-app-success-900/50 bg-app-success-950/20 p-3">
        <p class="flex items-center gap-1.5 text-2xs font-medium text-app-success-200/90">
          <UIcon name="i-lucide-check" class="h-3.5 w-3.5 shrink-0" />
          {{ t('settings.composeEnvSetup.needed.title') }}
        </p>
        <ul class="mt-1.5 list-disc space-y-1 ps-4 text-2xs leading-relaxed text-muted">
          <li v-for="(item, i) in needed" :key="`need-${i}`">{{ item }}</li>
        </ul>
      </div>
      <div class="rounded border border-default bg-default/40 p-3">
        <p class="flex items-center gap-1.5 text-2xs font-medium text-toned">
          <UIcon name="i-lucide-minus" class="h-3.5 w-3.5 shrink-0" />
          {{ t('settings.composeEnvSetup.notNeeded.title') }}
        </p>
        <ul class="mt-1.5 list-disc space-y-1 ps-4 text-2xs leading-relaxed text-muted">
          <li v-for="(item, i) in notNeeded" :key="`skip-${i}`">{{ item }}</li>
        </ul>
      </div>
    </div>

    <div class="flex items-center gap-2">
      <UButton
        size="xs"
        color="primary"
        variant="soft"
        icon="i-lucide-wand-sparkles"
        data-testid="compose-env-setup-start"
        @click="start()"
      >
        {{ t('settings.composeEnvSetup.start') }}
      </UButton>
      <span class="text-2xs text-dimmed">{{ t('settings.composeEnvSetup.rerunHint') }}</span>
    </div>
  </section>
</template>
