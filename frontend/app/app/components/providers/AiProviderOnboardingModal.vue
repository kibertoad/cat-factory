<script setup lang="ts">
// Shown when the workspace has NO usable AI model source. cat-factory only ships a working
// model out of the box on a Cloudflare deployment with Workers AI enabled; every other
// deployment needs the user to onboard at least one source. This dialog explains that and
// routes to each configuration surface (reusing the existing credential panels rather than
// duplicating them). It auto-opens once per session (driven from pages/index.vue) and, like
// the banner, disappears automatically the moment a usable source exists.
import { computed } from 'vue'

const ui = useUiStore()

const open = computed({
  get: () => ui.aiProviderSetupOpen,
  set: (v: boolean) => (v ? ui.openAiProviderSetup() : ui.closeAiProviderSetup()),
})

// Each route closes this dialog first so we never stack two modals, then opens the target
// panel. All of these panels are mounted in pages/index.vue alongside this one.
function go(action: () => void) {
  ui.closeAiProviderSetup()
  action()
}

interface Route {
  icon: string
  title: string
  body: string
  cta: string
  onSelect: () => void
}

const routes = computed<Route[]>(() => [
  {
    icon: 'i-lucide-key-round',
    title: 'Provider keys & subscriptions',
    body: 'Add a direct provider API key (OpenAI, Anthropic, Qwen, …) or connect a commercial coding-plan subscription (Kimi, DeepSeek) or a personal one (Claude, GLM, Codex).',
    cta: 'Open LLM vendors',
    onSelect: () => go(ui.openVendorCredentials),
  },
  {
    icon: 'i-lucide-route',
    title: 'OpenRouter gateway',
    body: 'Enable models through the OpenRouter gateway with a single key — browse and turn on the models you want.',
    cta: 'Browse OpenRouter models',
    onSelect: () => go(ui.openOpenRouter),
  },
  {
    icon: 'i-lucide-server',
    title: 'My local runners',
    body: 'Point cat-factory at a model you run yourself (Ollama, LM Studio, llama.cpp, vLLM, …). No API key, no spend.',
    cta: 'Configure local runners',
    onSelect: () => go(ui.openLocalModels),
  },
])
</script>

<template>
  <UModal v-model:open="open" title="Set up an AI model provider" :ui="{ content: 'max-w-2xl' }">
    <template #body>
      <div class="space-y-5">
        <div
          class="flex items-start gap-3 rounded-lg border border-amber-500/40 bg-amber-950/40 p-4"
        >
          <UIcon name="i-lucide-cpu" class="mt-0.5 h-6 w-6 shrink-0 text-amber-400" />
          <div class="min-w-0 text-sm text-amber-100/90">
            <p class="font-medium text-amber-100">
              No AI model is available on this workspace yet.
            </p>
            <p class="mt-1">
              Agents need a model to run. AI works out of the box only on a Cloudflare deployment
              with Workers AI enabled — otherwise connect at least one source below.
            </p>
          </div>
        </div>

        <div class="space-y-3">
          <div
            v-for="r in routes"
            :key="r.title"
            class="flex items-start gap-3 rounded-xl border border-slate-700 bg-slate-900/50 p-4"
          >
            <UIcon :name="r.icon" class="mt-0.5 h-5 w-5 shrink-0 text-indigo-300" />
            <div class="min-w-0 flex-1">
              <p class="text-sm font-semibold text-slate-100">{{ r.title }}</p>
              <p class="mt-0.5 text-[13px] leading-relaxed text-slate-400">{{ r.body }}</p>
            </div>
            <UButton
              size="sm"
              color="primary"
              variant="subtle"
              class="shrink-0"
              @click="r.onSelect()"
            >
              {{ r.cta }}
            </UButton>
          </div>
        </div>

        <p class="text-[11px] leading-relaxed text-slate-500">
          AWS Bedrock and Cloudflare Workers AI are enabled by the deployment operator via
          environment configuration, not from this screen.
        </p>
      </div>
    </template>
  </UModal>
</template>
