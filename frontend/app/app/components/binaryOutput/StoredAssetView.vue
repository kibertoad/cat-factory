<script setup lang="ts">
// A stored artifact the PLATFORM holds the bytes for: what it looks like, and the two things a
// person wants to do with it afterwards.
//
// This is the half of the media flow that only works because the shipped asset storage is our
// own. An artifact in an org's private bucket is a location string and, at best, whatever preview
// link that service chose to issue; one stored here is bytes we can serve, so the run's report can
// show the picture, open it full size, and hand the file over to be saved elsewhere.
//
// The bytes are behind the workspace's authenticated blob route, so an `<img src>` cannot point at
// them: they are fetched as a blob and turned into an object URL (`useArtifactBlobs`, the same
// composable the visual-confirmation gate uses). That is also why the DOWNLOAD is an `<a download>`
// over the object URL rather than a link to the API: a plain link would open an authenticated
// request the browser has no session header for.
//
// Whether the artifact renders as a picture is `rendersInlineAsImage`, the contracts rule the
// server clamps its own blob responses to. Everything else (a 3D model, an audio file, a PDF) is
// a legitimate outcome and NOT a failure: it renders as a named file with the same two actions,
// because the point of the surface is the file, not the thumbnail.
import { computed, onUnmounted, watch } from 'vue'
import { rendersInlineAsImage } from '@cat-factory/contracts'
import { useArtifactBlobs } from '~/composables/useArtifactBlobs'

const props = withDefaults(
  defineProps<{
    /** The platform artifact id (`art_…`) resolved off the row's service + location. */
    assetId: string
    /** The media type the agent reported, which decides picture-versus-file. */
    contentType?: string | undefined
    /** What to call the file a person saves, and the image's alt text. */
    label?: string | undefined
    /** Cap on the rendered preview's height, so a report row and a comparison card can differ. */
    previewClass?: string
  }>(),
  { contentType: undefined, label: undefined, previewClass: 'max-h-56' },
)
const { t } = useI18n()

const blobs = useArtifactBlobs()
onUnmounted(() => blobs.revokeAll())

// Re-resolve when the id changes rather than only on mount: one of these components is reused
// across the rows of a report that grows over a live run.
watch(
  () => props.assetId,
  (id) => void blobs.resolve(id),
  { immediate: true },
)

const url = computed(() => blobs.urlFor(props.assetId))
const status = computed(() => blobs.statusFor(props.assetId))
const isImage = computed(() => rendersInlineAsImage(props.contentType))

/**
 * The name the saved file takes. Derived from the agent's own label where there is one, because
 * `art_01H…` tells the person who saves it nothing about what it is; sanitised to the characters
 * a filename may safely carry, since the label is model-authored text going into a download.
 */
const filename = computed(() => {
  const base = (props.label ?? '')
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return base ? base.slice(0, 80) : props.assetId
})
</script>

<template>
  <div class="space-y-1.5" data-testid="stored-asset">
    <img
      v-if="isImage && url"
      :src="url"
      :alt="label ?? assetId"
      class="w-full rounded object-contain"
      :class="previewClass"
      data-testid="stored-asset-preview"
    />
    <!-- Not a picture, and that is an ordinary outcome for a media step: a mesh, a sound and a
         PDF are all deliverables, so the row states what it is rather than showing a broken
         frame. -->
    <p
      v-else-if="!isImage && url"
      class="flex items-center gap-1.5 rounded bg-slate-800/60 px-2 py-1.5 text-[11px] text-slate-300"
      data-testid="stored-asset-file"
    >
      <UIcon name="i-lucide-file" class="h-3.5 w-3.5 shrink-0" />
      <span class="truncate">{{ contentType ?? t('binaryOutput.asset.unknownType') }}</span>
    </p>
    <p
      v-else-if="status === 'error'"
      class="flex items-center gap-1.5 text-[11px] text-amber-300"
      data-testid="stored-asset-error"
    >
      <span>{{ t('binaryOutput.asset.loadFailed') }}</span>
      <UButton size="xs" variant="link" @click.stop="blobs.retry(assetId)">
        {{ t('binaryOutput.asset.retry') }}
      </UButton>
    </p>
    <p v-else class="text-[11px] text-slate-500" data-testid="stored-asset-loading">
      {{ t('binaryOutput.asset.loading') }}
    </p>

    <!-- The two things a person does with a delivered asset. Both hang off the object URL, so
         they appear only once the bytes are in hand. -->
    <div v-if="url" class="flex items-center gap-3 text-[11px]">
      <a
        :href="url"
        target="_blank"
        rel="noopener"
        class="text-sky-300 hover:underline"
        data-testid="stored-asset-open"
        @click.stop
        >{{ t('binaryOutput.asset.open') }}</a
      >
      <a
        :href="url"
        :download="filename"
        class="text-sky-300 hover:underline"
        data-testid="stored-asset-download"
        @click.stop
        >{{ t('binaryOutput.asset.download') }}</a
      >
    </div>
  </div>
</template>
